// Slice 58E — Route-A activities. The legacy fetch/preClassify/vision
// activities are deleted; doc-service owns OCR + extraction now and
// passes ProcessDocumentInput into the cert workflow.

// Slice 58C — cert strategy activity invoked by doc-service via
// ExecuteExtractionStrategyWorkflow on this queue.
export { extractCertFeaturesActivity } from './extract-cert-features.activity.js';

// Slice 58E — Route-A entry: cert workflow creates its own submission row.
export { createCertSubmissionRowActivity } from './create-cert-submission-row.activity.js';
export type {
  CreateCertSubmissionRowInput,
  CreateCertSubmissionRowOutput,
} from './create-cert-submission-row.activity.js';

// Slice 58E — back-signal to doc-service workflow on accept/reject.
export { signalDocumentServiceCallbackActivity } from './signal-document-service-callback.activity.js';
export type {
  SignalDocumentServiceCallbackInput,
  SignalDocumentServiceCallbackOutput,
} from './signal-document-service-callback.activity.js';

export { validateExtractionActivity } from './validate-extraction.activity.js';
export type { ValidateExtractionInput } from './validate-extraction.activity.js';

export { persistCertActivity } from './persist-cert.activity.js';
export type { PersistCertInput, PersistCertOutput } from './persist-cert.activity.js';

export { notifyHitlActivity } from './notify-hitl.activity.js';
export type { NotifyHitlInput } from './notify-hitl.activity.js';

// Slice 58D-B shim: cert workflow uses startChild('MatchPersonWorkflow')
// directly (see workflow); this activity is preserved for non-workflow
// callers and replaying older histories.
export { matchEmployee } from './match-employee.activity.js';
export type { MatchEmployeeInput, MatchEmployeeOutput } from './match-employee.activity.js';

// Slice 58D-B — terminal-failure activity for cert submissions whose
// subject could not be resolved by MatchPersonWorkflow.
export { rejectCertSubmissionActivity } from './reject-cert-submission.activity.js';
export type {
  RejectCertSubmissionInput,
  RejectCertSubmissionOutput,
} from './reject-cert-submission.activity.js';

export { matchCertDefinition } from './match-cert-definition.activity.js';
export type { MatchCertDefinitionInput, MatchCertDefinitionOutput } from './match-cert-definition.activity.js';

export { publishCertProcessedActivity } from './publish-cert-processed.activity.js';
export type { PublishCertProcessedInput } from './publish-cert-processed.activity.js';
