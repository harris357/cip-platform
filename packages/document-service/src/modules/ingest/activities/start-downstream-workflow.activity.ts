// Slice 58E — cross-queue workflow dispatch.
//
// Mirrors the cross-queue pattern from
// run-extraction-strategy.activity.ts: a thin activity on
// doc-service's queue uses `createTemporalClient` to start the
// matched module workflow on its own task queue. The downstream
// workflow runs as a peer (NOT a child of the doc-service workflow)
// — when it finishes it signals back to
// `DocumentProcess-${tenantId}-${documentId}` with a
// `moduleCallback` payload.
//
// Validates `ProcessDocumentInput` BEFORE start so an out-of-shape
// payload fails on this side rather than in the downstream worker.
//
// Workflow ID convention for the downstream record is module-specific
// (e.g. cert uses `CertProcess-${tenantId}-${certSubmissionId}`); we
// don't know the entity id yet here. Use the documentId as the
// dispatch-side correlator: `${workflowType}-${tenantId}-${documentId}`.
// The downstream module is free to pick its own internal entity id —
// it reports back via the moduleCallback signal, and
// handle-module-callback.activity persists the cross-reference.

import { z } from 'zod'

import {
  ProcessDocumentInputSchema,
  createTemporalClient,
  type ProcessDocumentInput,
} from '@cip/shared'

import { getDb } from '../../../db/index.js'
import { systemActorContext, withActorContext } from '../../../db/rls.js'
import { auditEvents } from '../../../db/schema.js'

export const StartDownstreamWorkflowInputSchema = z.object({
  tenantId:     z.string().uuid(),
  documentId:   z.string().uuid(),
  taskQueue:    z.string(),
  workflowType: z.string(),
  input:        ProcessDocumentInputSchema,
})
export type StartDownstreamWorkflowInput = z.infer<typeof StartDownstreamWorkflowInputSchema>

export const StartDownstreamWorkflowOutputSchema = z.object({
  workflowId: z.string(),
})
export type StartDownstreamWorkflowOutput = z.infer<typeof StartDownstreamWorkflowOutputSchema>

export async function startDownstreamWorkflowActivity(
  input: StartDownstreamWorkflowInput,
): Promise<StartDownstreamWorkflowOutput> {
  const validated = StartDownstreamWorkflowInputSchema.parse(input)

  const client = await createTemporalClient()
  // Workflow ID pattern: {workflowType}-{tenantId}-{entityId}
  const workflowId = `${validated.workflowType}-${validated.tenantId}-${validated.documentId}`

  await client.workflow.start(validated.workflowType, {
    workflowId,
    taskQueue: validated.taskQueue,
    args: [validated.input as ProcessDocumentInput],
  })

  // Audit the dispatch — the workflow trace already shows it, but the
  // doc-side audit_events table is the canonical place readers look.
  const db = getDb()
  await withActorContext(db, systemActorContext(validated.tenantId), async (tx) => {
    await tx.insert(auditEvents).values({
      tenantId:   validated.tenantId,
      documentId: validated.documentId,
      actorRole:  'system',
      eventType:  'routed',
      payload: {
        taskQueue:    validated.taskQueue,
        workflowType: validated.workflowType,
        workflowId,
        docType:      validated.input.docType,
      },
    })
  })

  return StartDownstreamWorkflowOutputSchema.parse({ workflowId })
}
