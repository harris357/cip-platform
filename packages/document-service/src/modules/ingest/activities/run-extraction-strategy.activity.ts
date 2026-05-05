// Slice 58C — extraction strategy dispatcher.
//
// IMPORTANT: this is an *activity*, not a workflow — Temporal workflow
// code can't reach across queues directly, so this thin activity runs
// inside the doc-service worker, resolves the strategy row via the
// registry, and uses a fresh Temporal Client to start (and await) the
// strategy activity on whichever task queue the row names. From the
// workflow's perspective it's a single activity with workflow-scoped
// retry semantics; from Temporal's perspective the strategy activity
// runs on the strategy's queue.
//
// Why not proxyActivities() in the workflow with a per-queue map? Two
// reasons:
//   1. proxyActivities is set up at workflow-module load time. The set
//      of strategies (and their queues) is per-tenant data, resolved
//      from the DB at workflow runtime.
//   2. The doc-service workflow MUST stay agnostic to the consumer-side
//      activity surface — type-only imports of every module are a
//      tighter coupling than this dispatcher.
//
// Output is Zod-parsed against ExtractionOutputSchema before persist.

import { eq, sql } from 'drizzle-orm'

import {
  ExtractionInputSchema,
  ExtractionOutputSchema,
  createTemporalClient,
  type ExtractionInput,
  type ExtractionOutput,
  type SensitivityTier,
} from '@cip/shared'

import { getDb } from '../../../db/index.js'
import { systemActorContext, withActorContext } from '../../../db/rls.js'
import { documents, auditEvents } from '../../../db/schema.js'
import { resolveStrategy } from '../../../extraction/registry.js'

export interface RunExtractionStrategyInput {
  tenantId:          string
  documentId:        string
  module:            string
  docType:           string
  sensitivityTier:   SensitivityTier
  ocrText:           string
  // s3 coords are optional — the activity loads them from the documents
  // row when omitted, so the workflow doesn't have to thread them through
  // every phase. Both supplied = use the supplied pair (saves a query).
  s3Bucket?:         string
  s3Key?:            string
  genericFeatures:   Record<string, unknown>
  uploaderHintText?: string
}

export class StrategyNotFoundError extends Error {
  constructor(module: string, docType: string) {
    super(`no enabled extraction strategy for module='${module}' doc_type='${docType}'`)
    this.name = 'StrategyNotFoundError'
  }
}

export async function runExtractionStrategyActivity(
  input: RunExtractionStrategyInput,
): Promise<ExtractionOutput> {
  const strategy = await resolveStrategy(input.tenantId, input.module, input.docType)
  if (!strategy) throw new StrategyNotFoundError(input.module, input.docType)

  // Resolve s3 coords if the caller didn't supply them — keeps the
  // workflow trace minimal (it doesn't have to thread bucket+key through
  // every phase) at the cost of one extra round-trip on dispatch.
  let s3Bucket = input.s3Bucket
  let s3Key    = input.s3Key
  if (!s3Bucket || !s3Key) {
    const db = getDb()
    const row = await withActorContext(db, systemActorContext(input.tenantId), async (tx) => {
      const rows = await tx.select({
        s3Bucket: documents.s3Bucket,
        s3Key:    documents.s3Key,
      })
        .from(documents)
        .where(eq(documents.id, input.documentId))
      return rows[0]
    })
    if (!row) throw new Error(`run-extraction-strategy: doc ${input.documentId} not found`)
    s3Bucket = row.s3Bucket
    s3Key    = row.s3Key
  }

  // Build the strategy input. Validate before send so an out-of-shape
  // payload fails on this side rather than on the consumer.
  const payload: ExtractionInput = ExtractionInputSchema.parse({
    tenantId:         input.tenantId,
    documentId:       input.documentId,
    module:           input.module,
    docType:          input.docType,
    ocrText:          input.ocrText,
    s3Bucket,
    s3Key,
    genericFeatures:  input.genericFeatures,
    sensitivityTier:  input.sensitivityTier,
    ...(input.uploaderHintText !== undefined ? { uploaderHintText: input.uploaderHintText } : {}),
    config:           strategy.configJson,
  })

  // Cross-queue dispatch: open a Temporal client and run the strategy
  // activity through a thin "executor" workflow on the target queue.
  // Direct Activity.execute() exists, but the cleanest cross-queue
  // pattern in Temporal SDK 1.17 is to start a workflow that proxies
  // the activity on its own queue. We model it as start + await result
  // via a synchronous handle. No extra workflow file needed if the
  // dispatcher itself is the activity (not the workflow) — the
  // workflow we start IS the strategy activity's host workflow.
  //
  // Implementation: use Temporal Client's `workflow.execute` against
  // a generic "execute-extraction-strategy" workflow that the strategy
  // service registers. The hr-service registers this workflow on the
  // cip-hr-tasks queue.
  const client = await createTemporalClient()
  const workflowId =
    `ExtractionStrategy-${input.tenantId}-${input.documentId}-${input.module}-${input.docType}`

  // Slice 58C-FIX — emit extraction_started before dispatch so the
  // audit trail captures every attempt, even ones that subsequently
  // crash mid-strategy.
  await recordStarted(input, strategy.strategyName, strategy.taskQueue, strategy.activityName)

  // Workflow ID pattern: {workflowType}-{tenantId}-{entityId}
  const handle = await client.workflow.start('ExecuteExtractionStrategyWorkflow', {
    workflowId,
    taskQueue: strategy.taskQueue,
    args: [{
      activityName: strategy.activityName,
      input:        payload,
    }],
  })

  let raw: unknown
  try {
    raw = await handle.result()
  } catch (err) {
    // Persist the failure for forensic purposes; rethrow so the
    // doc-service workflow's retry policy decides.
    await recordFailure(input, strategy.strategyName, err)
    throw err
  }

  const parsed: ExtractionOutput = ExtractionOutputSchema.parse(raw)
  await persistExtraction(input, strategy.strategyName, parsed)
  return parsed
}

async function recordStarted(
  input:        RunExtractionStrategyInput,
  strategyName: string,
  taskQueue:    string,
  activityName: string,
): Promise<void> {
  const db = getDb()
  await withActorContext(db, systemActorContext(input.tenantId), async (tx) => {
    await tx.insert(auditEvents).values({
      tenantId:   input.tenantId,
      documentId: input.documentId,
      actorRole:  'system',
      eventType:  'extraction_started',
      payload: {
        strategyName,
        module:  input.module,
        docType: input.docType,
        taskQueue,
        activityName,
      },
    })
  })
}

async function recordFailure(
  input:        RunExtractionStrategyInput,
  strategyName: string,
  err:          unknown,
): Promise<void> {
  const db = getDb()
  await withActorContext(db, systemActorContext(input.tenantId), async (tx) => {
    await tx.insert(auditEvents).values({
      tenantId:   input.tenantId,
      documentId: input.documentId,
      actorRole:  'system',
      eventType:  'extraction_failed',
      payload: {
        strategyName,
        module:  input.module,
        docType: input.docType,
        error:   err instanceof Error ? err.message : String(err),
      },
    })
  })
}

async function persistExtraction(
  input:        RunExtractionStrategyInput,
  strategyName: string,
  out:          ExtractionOutput,
): Promise<void> {
  const db = getDb()
  await withActorContext(db, systemActorContext(input.tenantId), async (tx) => {
    await tx.update(documents).set({
      extractedFeatures:    out.fields,
      extractionConfidence: out.extractionConfidence,
      updatedAt:            sql`NOW()`,
    }).where(eq(documents.id, input.documentId))

    await tx.insert(auditEvents).values({
      tenantId:   input.tenantId,
      documentId: input.documentId,
      actorRole:  'system',
      eventType:  'extraction_completed',
      payload: {
        strategyName,
        module:        input.module,
        docType:       input.docType,
        fieldCount:    Object.keys(out.fields).length,
        confidence:    out.extractionConfidence,
        evidence:      out.evidence,
      },
    })
  })
}
