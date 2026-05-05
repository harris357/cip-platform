// Slice 58B — DocumentProcessingWorkflow.
//
// CRITICAL STRUCTURAL CONSTRAINT (slice doc, "Critical structural
// constraint"): this MUST be a phase loop, NOT a linear `await scan();
// await features(); ...` chain. 58F's reclassification flow signals
// the workflow back to phase='classify', and 58G's restore-and-resume
// resumes at an arbitrary phase. Building the loop now costs ~30 lines
// of dispatch and is structurally identical on the happy path; reshape-
// ing later would be a painful rewrite.
//
// Phases beyond 'sensitivity' (classify/subject/route/...) are placeholders
// in 58B — the workflow exits after sensitivity with the DB lifecycle
// state at 'classifying' for slice 58C to pick up. The signal handler
// is wired (defineSignal) so 58F can land its reclassify path without
// re-touching this file.
//
// All progress publishing is best-effort — see publishProgressActivity.

import { proxyActivities, defineSignal, setHandler, condition } from '@temporalio/workflow'

// Slice 58E — webpack-bundled workflow context. `import type` for
// @cip/shared so zod schemas don't pull node-only modules into the
// bundle (slice 58C learned this; do not regress).
import type {
  ProcessDocumentInput,
  ModuleCallbackSignal,
  RoutingResolutionSignal,
} from '@cip/shared'

import type * as activities from '../activities/index.js'

const {
  scanForVirusesActivity,
  extractGenericFeaturesActivity,
  computeEmbeddingActivity,
  computeLayoutFingerprintActivity,
  publishProgressActivity,
  transitionToClassifyingActivity,
  transitionLifecycleStateActivity,
  loadDocumentsTunablesActivity,
  // Slice 58E — routing dispatch + callback handling.
  routeDocumentActivity,
  startDownstreamWorkflowActivity,
  handleModuleCallbackActivity,
  persistDownstreamRecordActivity,
} = proxyActivities<typeof activities>({
  startToCloseTimeout: '60 seconds',
  retry: {
    maximumAttempts: 5,
    initialInterval: '5 seconds',
    backoffCoefficient: 2,
    nonRetryableErrorTypes: ['ThreatDetected', 'CorruptDocument'],
  },
})

const { scoreSensitivityActivity, classifyDocumentActivity } = proxyActivities<typeof activities>({
  // LLM-backed activities — Mistral small can spike to 60-90s under load.
  startToCloseTimeout: '5 minutes',
  retry: { maximumAttempts: 3 },
})

const { runExtractionStrategyActivity } = proxyActivities<typeof activities>({
  // Extraction strategy can be heavy (vision agent does multi-step LLM
  // work). The dispatcher activity itself starts a workflow on another
  // queue and awaits its result, so the timeout has to cover that whole
  // round-trip — generous to absorb queue-side scheduling latency.
  startToCloseTimeout: '15 minutes',
  retry: {
    maximumAttempts: 3,
    initialInterval: '15 seconds',
    backoffCoefficient: 2,
    // StrategyNotFoundError is a config error, not a transient failure
    // — let the workflow surface it once and route to HITL via the
    // catch handler in the extract case.
    nonRetryableErrorTypes: ['StrategyNotFoundError'],
  },
})

// ─── Phase + signal scaffold ────────────────────────────────────────────

export type DocumentPhase =
  | 'scan'
  | 'features'
  | 'sensitivity'
  | 'classify'                    // 58C boundary — workflow exits here in 58B
  | 'extract'                     // 58C
  | 'subject'                     // 58D
  | 'route'                       // 58E
  | 'awaiting_module_callback'    // 58E
  | 'archived'                    // 58E terminal
  | 'failed'                      // terminal

export interface ReclassifyPayload {
  // Slice 58F populates this; in 58B the signal handler is registered
  // but never fires.
  reason:        string
  requestedBy:   string
  requestId:     string
}
export const reclassifySignal = defineSignal<[ReclassifyPayload]>('reclassify')

export interface DocumentProcessingInput {
  tenantId:             string
  documentId:           string
  conversationId?:      string
  uploaderEmployeeId:   string
  uploaderHintText?:    string
  /**
   * Slice 58E — S3 coordinates threaded from the document_process MCP
   * tool. The workflow forwards them to downstream modules via
   * `ProcessDocumentInput.{s3Bucket, s3Key}`. Optional for back-compat;
   * activities re-read from the documents row when missing.
   */
  s3Bucket?:            string
  s3Key?:               string
  /**
   * Slice 58E — forwarded actor envelope. Loose record so the slice
   * doesn't lock the shape; downstream consumers cast as needed.
   */
  actorContext?:        Record<string, unknown>
  /** 58G restore: resume at a specific phase. Defaults to 'scan'. */
  startingPhase?:       DocumentPhase
}

export async function DocumentProcessingWorkflow(input: DocumentProcessingInput): Promise<void> {
  // Workflow ID pattern: {workflowType}-{tenantId}-{entityId}
  // workflowId: `DocumentProcess-${input.tenantId}-${input.documentId}`
  const { tenantId, documentId, conversationId, uploaderHintText, uploaderEmployeeId } = input

  // Reclassify signal: 58F payload, queue once and consume next loop turn.
  let reclassifyPayload: ReclassifyPayload | undefined
  setHandler(reclassifySignal, (payload) => {
    reclassifyPayload = payload
  })

  let phase: DocumentPhase = input.startingPhase ?? 'scan'

  // Per-step generic features cache — populated when 'features' runs and
  // consumed by later phases that need ocrText / fileName / mimeType.
  // Persisted on the documents row so 58G's restore-and-resume can re-
  // hydrate; in 58B we keep the in-memory copy for the linear path.
  let cachedGenericFeatures: activities.GenericFeatures | null = null
  // Slice 58C — sensitivity tier carries through to classify+extract;
  // cached in the workflow because the activities consume it as input
  // rather than re-reading from DB.
  let cachedSensitivityTier: 'public' | 'internal' | 'confidential' | 'restricted' | null = null
  // Slice 58C — classify result cached for the extract phase; on
  // reclassify (slice 58F) the new value replaces this.
  let cachedClassification: activities.ClassifyDocumentOutput | null = null
  // Slice 58E — extracted features cached for the route phase, which
  // forwards them to the downstream module workflow as
  // ProcessDocumentInput.extractedFeatures.
  let cachedExtraction: { fields: Record<string, unknown>; extractionConfidence: number } | null = null
  // Slice 58E — s3 coords cached for ProcessDocumentInput.{s3Bucket,s3Key}.
  // Seeded from input when the MCP tool threaded them through; otherwise
  // re-resolved by run-extraction-strategy from the DB row.
  let cachedS3Bucket: string | null = input.s3Bucket ?? null
  let cachedS3Key:    string | null = input.s3Key    ?? null
  // Slice 58E — downstream workflow handle id, captured at dispatch and
  // applied on the moduleCallback signal.
  let cachedDownstreamWorkflowId: string | null = null
  let cachedDownstreamWorkflowType: string | null = null

  // Slice 58E — module callback signal: downstream module workflow
  // signals success/failure with `{moduleRecordId, status, reason?}`.
  let moduleCallback: ModuleCallbackSignal | undefined
  const moduleCallbackSignal = defineSignal<[ModuleCallbackSignal]>('moduleCallback')
  setHandler(moduleCallbackSignal, (s) => { moduleCallback = s })

  // Slice 58E — routing-resolution signal: admin tools resolve a
  // doc parked in `hitl_admin_queue` due to no_routing_rule by sending
  // either {action:'route', module, docType} (re-targets and retries
  // route) or {action:'reject', reason?} (transitions to 'failed').
  let routingResolution: RoutingResolutionSignal | undefined
  const routingResolutionSignal = defineSignal<[RoutingResolutionSignal]>('routingResolution')
  setHandler(routingResolutionSignal, (s) => { routingResolution = s })

  type ProgressStep   = Parameters<typeof publishProgressActivity>[0]['step']
  type ProgressStatus = Parameters<typeof publishProgressActivity>[0]['status']

  const progress = async (
    step: ProgressStep,
    status: ProgressStatus,
    detail?: Record<string, unknown>,
  ): Promise<void> => {
    if (!conversationId) return
    await publishProgressActivity({
      tenantId,
      documentId,
      conversationId,
      step,
      status,
      ...(detail !== undefined ? { detail } : {}),
    })
  }

  while (phase !== 'archived' && phase !== 'failed') {
    // Reclassify hook: 58F lands here. In 58B the signal never fires.
    if (reclassifyPayload) {
      reclassifyPayload = undefined
      phase = 'classify'
      continue
    }

    switch (phase) {
      case 'scan': {
        await progress('scan', 'started')
        const scan = await scanForVirusesActivity({ tenantId, documentId })
        if (!scan.clean) {
          // scanForVirusesActivity has already transitioned the DB to
          // scan_failed and recorded the audit event. The Temporal
          // ApplicationFailure is non-retryable, so on detection the
          // activity throws and we never reach this branch — keeping
          // it for completeness in case the activity contract evolves.
          await progress('scan', 'failed', { threat: scan.threat })
          phase = 'failed'
          break
        }
        await progress('scan', 'completed')
        phase = 'features'
        break
      }

      case 'features': {
        await progress('generic_features', 'started')
        const generic = await extractGenericFeaturesActivity({ tenantId, documentId })
        cachedGenericFeatures = generic
        await progress('generic_features', 'completed', { pageCount: generic.pageCount })

        await progress('embedding', 'started')
        await computeEmbeddingActivity({ tenantId, documentId, ocrText: generic.ocrText })
        await progress('embedding', 'completed')

        await progress('fingerprint', 'started')
        await computeLayoutFingerprintActivity({ tenantId, documentId })
        await progress('fingerprint', 'completed')

        phase = 'sensitivity'
        break
      }

      case 'sensitivity': {
        await progress('sensitivity', 'started')
        if (!cachedGenericFeatures) {
          // Only happens if startingPhase pushed us straight here without
          // running 'features' (58G restore). 58B can't reproduce that
          // path; fail loudly so the bug surfaces before 58G enables it.
          throw new Error('sensitivity phase: cachedGenericFeatures missing — restart from scan')
        }
        const sens = await scoreSensitivityActivity({
          tenantId,
          documentId,
          ocrText:   cachedGenericFeatures.ocrText,
          fileName:  cachedGenericFeatures.fileName,
          mimeType:  cachedGenericFeatures.mimeType,
          ...(uploaderHintText !== undefined ? { uploaderHintText } : {}),
        })
        cachedSensitivityTier = sens.tier
        await progress('sensitivity', 'completed', { tier: sens.tier })

        // Transition documents.lifecycle_state → 'classifying' before
        // entering the classify phase. Idempotent on retry. The slice-58B
        // helper is preserved (in-flight workflows still replay through it);
        // new workflow runs use it just the same.
        await transitionToClassifyingActivity({ tenantId, documentId })
        phase = 'classify'
        break
      }

      case 'classify': {
        await progress('classify', 'started')
        if (!cachedGenericFeatures) {
          throw new Error('classify phase: cachedGenericFeatures missing — restart from scan')
        }

        // Tunable: classify_confidence_threshold. Loaded once per phase
        // entry (cheap with the tunables 5-min cache); reclassification
        // re-enters this case and re-reads to honour live admin changes.
        const tunables = await loadDocumentsTunablesActivity({ tenantId })

        const cls = await classifyDocumentActivity({
          tenantId,
          documentId,
          ocrText:         cachedGenericFeatures.ocrText,
          fileName:        cachedGenericFeatures.fileName,
          mimeType:        cachedGenericFeatures.mimeType,
          ...(uploaderHintText !== undefined ? { uploaderHintText } : {}),
          // sensitivityTier is persisted on the row by the sensitivity
          // phase; classify activity reads from input rather than DB so
          // the workflow trace shows the value used. Reload from cache.
          sensitivityTier: cachedSensitivityTier ?? 'public',
          genericFeatures: cachedGenericFeatures as unknown as Record<string, unknown>,
        })
        await progress('classify', 'completed', {
          module:     cls.module,
          docType:    cls.docType,
          confidence: cls.confidence,
        })

        if (cls.confidence < tunables.classifyConfidenceThreshold) {
          // Park in HITL queue; 58D's admin tools resolve.
          await transitionLifecycleStateActivity({
            tenantId,
            documentId,
            to:            'hitl_admin_queue',
            preHitlState:  'classifying',
            reason:        'low_classification_confidence',
            module:        cls.module,
            docType:       cls.docType,
          })
          return
        }

        cachedClassification = cls
        phase = 'extract'
        break
      }

      case 'extract': {
        await progress('extract', 'started')
        if (!cachedGenericFeatures) {
          throw new Error('extract phase: cachedGenericFeatures missing — restart from scan')
        }
        if (!cachedClassification) {
          throw new Error('extract phase: cachedClassification missing — re-run classify')
        }

        try {
          const extracted = await runExtractionStrategyActivity({
            tenantId,
            documentId,
            module:           cachedClassification.module,
            docType:          cachedClassification.docType,
            sensitivityTier:  cachedSensitivityTier ?? 'public',
            ocrText:          cachedGenericFeatures.ocrText,
            genericFeatures:  cachedGenericFeatures as unknown as Record<string, unknown>,
            ...(uploaderHintText !== undefined ? { uploaderHintText } : {}),
            // Slice 58E — registry honors mime_filter when provided.
            ...(cachedGenericFeatures.mimeClass !== undefined ? { mimeClass: cachedGenericFeatures.mimeClass } : {}),
          })
          // Slice 58E — cache for the route phase to forward as
          // ProcessDocumentInput.{extractedFeatures, extractionConfidence}.
          cachedExtraction = {
            fields:               extracted.fields,
            extractionConfidence: extracted.extractionConfidence,
          }
          await progress('extract', 'completed', {
            fieldCount: Object.keys(extracted.fields).length,
            confidence: extracted.extractionConfidence,
          })
        } catch (err) {
          // No registered strategy for this (module, docType) — treat as a
          // misclassification: park in HITL with the error reason. Other
          // failures bubble (Temporal retries; nonRetryable types fail the
          // workflow so an alert fires).
          const isStrategyNotFound = (err as { name?: string } | undefined)?.name === 'StrategyNotFoundError'
          if (!isStrategyNotFound) throw err

          await progress('extract', 'failed', {
            reason: 'no_extraction_strategy',
            module: cachedClassification.module,
            docType: cachedClassification.docType,
          })
          await transitionLifecycleStateActivity({
            tenantId,
            documentId,
            to:           'hitl_admin_queue',
            preHitlState: 'classifying',
            reason:       'no_extraction_strategy',
          })
          return
        }

        // Hand off to the subject phase (58D fills it). Move the lifecycle
        // state pointer here so external observers see the doc graduate
        // out of 'classifying' even before 58D ships.
        await transitionLifecycleStateActivity({
          tenantId,
          documentId,
          to: 'awaiting_subject',
        })
        phase = 'subject'
        break
      }

      case 'subject': {
        // Slice 58E — Route-A locks subject resolution INSIDE the
        // downstream module workflow (cert runs MatchPersonWorkflow as
        // a child workflow). Doc-service no longer pre-resolves a
        // subject; the lifecycle pointer just graduates to
        // awaiting_routing so external observers see progress.
        await transitionLifecycleStateActivity({
          tenantId,
          documentId,
          to: 'awaiting_routing',
        })
        phase = 'route'
        break
      }

      case 'route': {
        if (!cachedClassification) {
          throw new Error('route phase: cachedClassification missing — re-run classify')
        }
        if (!cachedExtraction) {
          throw new Error('route phase: cachedExtraction missing — re-run extract')
        }
        if (!cachedGenericFeatures) {
          throw new Error('route phase: cachedGenericFeatures missing — restart from scan')
        }

        await progress('route', 'started')

        // Resolve the (module, doc_type) → (taskQueue, workflowType)
        // routing rule. Loop allows admin-supplied retargeting via the
        // routingResolution signal when no rule matches initially.
        let routeModule  = cachedClassification.module
        let routeDocType = cachedClassification.docType

        // eslint-disable-next-line no-constant-condition
        while (true) {
          const routing = await routeDocumentActivity({
            tenantId,
            documentId,
            module:  routeModule,
            docType: routeDocType,
          })

          if (routing.matched) {
            // Resolve s3 coords from cache or re-read via dispatcher.
            const s3Bucket = cachedS3Bucket ?? ''
            const s3Key    = cachedS3Key    ?? ''
            const dispatched = await startDownstreamWorkflowActivity({
              tenantId,
              documentId,
              taskQueue:    routing.taskQueue,
              workflowType: routing.workflowType,
              input: {
                tenantId,
                documentId,
                uploaderEmployeeId,
                ...(uploaderHintText !== undefined ? { uploaderHintText } : {}),
                ...(conversationId   !== undefined ? { conversationId }   : {}),
                docType:              routeDocType,
                extractedFeatures:    cachedExtraction.fields,
                extractionConfidence: cachedExtraction.extractionConfidence,
                genericFeatures:      cachedGenericFeatures as unknown as Record<string, unknown>,
                sensitivityTier:      cachedSensitivityTier ?? 'public',
                s3Bucket,
                s3Key,
                actorContext:         input.actorContext ?? {},
              },
            })
            cachedDownstreamWorkflowId   = dispatched.workflowId
            cachedDownstreamWorkflowType = routing.workflowType

            await transitionLifecycleStateActivity({
              tenantId,
              documentId,
              to: 'routed',
            })
            await progress('route', 'completed', {
              downstreamWorkflowId:   dispatched.workflowId,
              downstreamWorkflowType: routing.workflowType,
              module:                 routing.matchedModule,
              docType:                routing.matchedDocType,
            })
            phase = 'awaiting_module_callback'
            break
          }

          // No routing rule — park in HITL admin queue and wait for
          // signal-driven resolution (route action retargets; reject
          // transitions to failed).
          await transitionLifecycleStateActivity({
            tenantId,
            documentId,
            to:            'hitl_admin_queue',
            preHitlState:  'awaiting_routing',
            reason:        'no_routing_rule',
            module:        routeModule,
            docType:       routeDocType,
          })
          await progress('route', 'failed', {
            reason:  'no_routing_rule',
            module:  routeModule,
            docType: routeDocType,
          })

          // Wait for admin tooling to signal a resolution. No timeout —
          // the doc sits in HITL until handled (matches existing
          // hitl_admin_queue semantics).
          await condition(() => routingResolution !== undefined)
          const resolution = routingResolution!
          routingResolution = undefined

          if (resolution.action === 'reject') {
            await transitionLifecycleStateActivity({
              tenantId,
              documentId,
              to:     'failed',
              ...(resolution.reason !== undefined ? { reason: resolution.reason } : {}),
            })
            phase = 'failed'
            break
          }

          // 'route' — admin supplied a fresh (module, doc_type) pair.
          // Move back to awaiting_routing and re-attempt resolution.
          routeModule  = resolution.module
          routeDocType = resolution.docType
          await transitionLifecycleStateActivity({
            tenantId,
            documentId,
            to:      'awaiting_routing',
            module:  routeModule,
            docType: routeDocType,
          })
          // loop
        }
        break
      }

      case 'awaiting_module_callback': {
        // Wait for the downstream module workflow to signal back. No
        // timeout — module-side timeouts are owned by the module
        // workflow's own retry/HITL policy.
        await condition(() => moduleCallback !== undefined)
        const cb = moduleCallback!

        await handleModuleCallbackActivity({
          tenantId,
          documentId,
          moduleRecordId:       cb.moduleRecordId,
          downstreamWorkflowId: cachedDownstreamWorkflowId ?? '',
          workflowType:         cachedDownstreamWorkflowType ?? '',
          status:               cb.status,
          ...(cb.reason !== undefined ? { reason: cb.reason } : {}),
        })

        await persistDownstreamRecordActivity({
          tenantId,
          documentId,
          moduleRecordId: cb.moduleRecordId,
          status:         cb.status,
        })

        if (cb.status === 'rejected') {
          await transitionLifecycleStateActivity({
            tenantId,
            documentId,
            to:     'failed',
            ...(cb.reason !== undefined ? { reason: cb.reason } : {}),
          })
          await progress('archive', 'failed', { moduleRecordId: cb.moduleRecordId, reason: cb.reason ?? 'rejected' })
          phase = 'failed'
          break
        }

        await transitionLifecycleStateActivity({
          tenantId,
          documentId,
          to: 'archived',
        })
        await progress('archive', 'completed', { moduleRecordId: cb.moduleRecordId })
        phase = 'archived'
        break
      }
    }
  }
}
