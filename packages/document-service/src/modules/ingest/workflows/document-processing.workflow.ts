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

import { proxyActivities, defineSignal, setHandler } from '@temporalio/workflow'

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
  /** 58G restore: resume at a specific phase. Defaults to 'scan'. */
  startingPhase?:       DocumentPhase
}

export async function DocumentProcessingWorkflow(input: DocumentProcessingInput): Promise<void> {
  // Workflow ID pattern: {workflowType}-{tenantId}-{entityId}
  // workflowId: `DocumentProcess-${input.tenantId}-${input.documentId}`
  const { tenantId, documentId, conversationId, uploaderHintText } = input

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
          })
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

      case 'subject':
      case 'route':
      case 'awaiting_module_callback':
        // Slice 58D / 58E own these phases. In 58C, exit at 'subject'
        // with the DB lifecycle state already at 'awaiting_subject' —
        // 58D will start a new workflow (or signal this one) to resume.
        return
    }
  }
}
