export {
  CertificationProcessingWorkflow,
  hitlDecisionSignal,
} from './certification-processing.workflow.js';
export type { CertificationProcessingWorkflowInput } from './certification-processing.workflow.js';

// Slice 58C — generic strategy executor that runs extract-*-features
// activities on the cip-hr-tasks queue when started by doc-service.
export { ExecuteExtractionStrategyWorkflow } from './execute-extraction-strategy.workflow.js';
export type { ExecuteExtractionStrategyInput } from './execute-extraction-strategy.workflow.js';
