// Slice 58B — ingest activity registry. The temporal worker imports
// this module wholesale (`import * as activities`) and registers every
// exported function. Adding a new activity here = one spot to wire.

export { scanForVirusesActivity }                from './scan-for-viruses.activity.js'
export type { ScanForVirusesInput, ScanForVirusesOutput } from './scan-for-viruses.activity.js'

export { extractGenericFeaturesActivity, GenericFeaturesSchema } from './extract-generic-features.activity.js'
export type { ExtractGenericFeaturesInput, GenericFeatures }     from './extract-generic-features.activity.js'

export { computeEmbeddingActivity, ComputeEmbeddingOutputSchema } from './compute-embedding.activity.js'
export type { ComputeEmbeddingInput, ComputeEmbeddingOutput }     from './compute-embedding.activity.js'

export { computeLayoutFingerprintActivity, ComputeLayoutFingerprintOutputSchema } from './compute-layout-fingerprint.activity.js'
export type { ComputeLayoutFingerprintInput, ComputeLayoutFingerprintOutput }     from './compute-layout-fingerprint.activity.js'

export { scoreSensitivityActivity, ScoreSensitivityOutputSchema } from './score-sensitivity.activity.js'
export type { ScoreSensitivityInput, ScoreSensitivityOutput }     from './score-sensitivity.activity.js'

export { publishProgressActivity }      from './publish-progress.activity.js'
export type { PublishProgressInput }    from './publish-progress.activity.js'

export { transitionToClassifyingActivity } from './transition-to-classifying.activity.js'
export type { TransitionToClassifyingInput } from './transition-to-classifying.activity.js'

// Slice 58C — generic state-transition helper used by every phase from
// classify onward. transitionToClassifyingActivity stays for backward
// compat with existing in-flight workflows (Temporal replays history).
export { transitionLifecycleStateActivity } from './transition-lifecycle-state.activity.js'
export type { TransitionLifecycleStateInput } from './transition-lifecycle-state.activity.js'

export { classifyDocumentActivity, ClassifyDocumentOutputSchema } from './classify-document.activity.js'
export type { ClassifyDocumentInput, ClassifyDocumentOutput }     from './classify-document.activity.js'

export { runExtractionStrategyActivity, StrategyNotFoundError } from './run-extraction-strategy.activity.js'
export type { RunExtractionStrategyInput }                      from './run-extraction-strategy.activity.js'

export { loadDocumentsTunablesActivity }     from './load-tunables.activity.js'
export type { LoadDocumentsTunablesInput }   from './load-tunables.activity.js'

// Slice 58E — routing dispatch + module callback + final persistence.
export { routeDocumentActivity, RouteDocumentOutputSchema } from './route-document.activity.js'
export type { RouteDocumentInput, RouteDocumentOutput }     from './route-document.activity.js'

export { startDownstreamWorkflowActivity, StartDownstreamWorkflowOutputSchema } from './start-downstream-workflow.activity.js'
export type { StartDownstreamWorkflowInput, StartDownstreamWorkflowOutput }     from './start-downstream-workflow.activity.js'

export { handleModuleCallbackActivity, HandleModuleCallbackOutputSchema } from './handle-module-callback.activity.js'
export type { HandleModuleCallbackInput, HandleModuleCallbackOutput }     from './handle-module-callback.activity.js'

export { persistDownstreamRecordActivity, PersistDownstreamRecordOutputSchema } from './persist-downstream-record.activity.js'
export type { PersistDownstreamRecordInput, PersistDownstreamRecordOutput }     from './persist-downstream-record.activity.js'
