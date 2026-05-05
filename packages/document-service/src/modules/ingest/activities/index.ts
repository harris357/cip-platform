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
