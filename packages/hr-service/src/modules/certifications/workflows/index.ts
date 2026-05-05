export {
  CertificationProcessingWorkflow,
  hitlDecisionSignal,
} from './certification-processing.workflow.js';
// Slice 58E — `CertificationProcessingWorkflowInput` removed; the
// workflow now consumes `ProcessDocumentInput` from `@cip/shared`
// directly. Existing callers should import that type from
// `@cip/shared` instead of from this file.

// Slice 58C — generic strategy executor that runs extract-*-features
// activities on the cip-hr-tasks queue when started by doc-service.
export { ExecuteExtractionStrategyWorkflow } from './execute-extraction-strategy.workflow.js';
export type { ExecuteExtractionStrategyInput } from './execute-extraction-strategy.workflow.js';
