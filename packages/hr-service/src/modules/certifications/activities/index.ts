export { fetchDocumentActivity } from './fetch-document.activity.js';
export type { FetchDocumentInput, FetchDocumentOutput } from './fetch-document.activity.js';

export { preClassifyCertActivity } from './pre-classify-cert.activity.js';
export type { PreClassifyCertInput, PreClassifyCertOutput } from './pre-classify-cert.activity.js';

export { runVisionAgentActivity } from './run-vision-agent.activity.js';
export type { RunVisionAgentInput } from './run-vision-agent.activity.js';

// Slice 58C — cert strategy activity invoked by doc-service via
// ExecuteExtractionStrategyWorkflow on this queue.
export { extractCertFeaturesActivity } from './extract-cert-features.activity.js';

export { validateExtractionActivity } from './validate-extraction.activity.js';
export type { ValidateExtractionInput } from './validate-extraction.activity.js';

export { persistCertActivity } from './persist-cert.activity.js';
export type { PersistCertInput, PersistCertOutput } from './persist-cert.activity.js';

export { notifyHitlActivity } from './notify-hitl.activity.js';
export type { NotifyHitlInput } from './notify-hitl.activity.js';

export { matchEmployee } from './match-employee.activity.js';
export type { MatchEmployeeInput, MatchEmployeeOutput } from './match-employee.activity.js';

export { matchCertDefinition } from './match-cert-definition.activity.js';
export type { MatchCertDefinitionInput, MatchCertDefinitionOutput } from './match-cert-definition.activity.js';

export { publishCertProcessedActivity } from './publish-cert-processed.activity.js';
export type { PublishCertProcessedInput } from './publish-cert-processed.activity.js';
