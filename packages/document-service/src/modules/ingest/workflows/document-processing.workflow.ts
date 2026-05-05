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
} = proxyActivities<typeof activities>({
  startToCloseTimeout: '60 seconds',
  retry: {
    maximumAttempts: 5,
    initialInterval: '5 seconds',
    backoffCoefficient: 2,
    nonRetryableErrorTypes: ['ThreatDetected', 'CorruptDocument'],
  },
})

const { scoreSensitivityActivity } = proxyActivities<typeof activities>({
  // L3 LLM rubric occasionally needs the longer timeout — Mistral
  // small can spike to 60-90s under load.
  startToCloseTimeout: '5 minutes',
  retry: { maximumAttempts: 3 },
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
        await progress('sensitivity', 'completed', { tier: sens.tier })

        // Transition documents.lifecycle_state → 'classifying' before exit
        // so it's observable from documents_status. Idempotent on retry.
        await transitionToClassifyingActivity({ tenantId, documentId })
        phase = 'classify'
        break
      }

      case 'classify':
      case 'extract':
      case 'subject':
      case 'route':
      case 'awaiting_module_callback':
        // Slice 58C+ owns these phases. In 58B, exiting here is the
        // expected behavior — the workflow halts with documents.lifecycle_state
        // = 'classifying' and 58C picks it up via a separate workflow
        // (or a signal — 58C decides).
        return
    }
  }
}
