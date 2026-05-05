export { CertificationProcessingWorkflow, hitlDecisionSignal } from '../modules/certifications/workflows/certification-processing.workflow.js';
export { EmployeeOnboardingWorkflow } from '../modules/employees/workflows/employee-onboarding.workflow.js';
export type { EmployeeOnboardingInput } from '../modules/employees/workflows/employee-onboarding.workflow.js';

// Slice 33: identity migration + disable workflows
export { EmployeeIdentityMigrationWorkflow } from '../modules/employees/workflows/employee-identity-migration.workflow.js';
export type { EmployeeIdentityMigrationInput } from '../modules/employees/workflows/employee-identity-migration.workflow.js';

export { EmployeeDisableWorkflow } from '../modules/employees/workflows/employee-disable.workflow.js';
export type { EmployeeDisableInput } from '../modules/employees/workflows/employee-disable.workflow.js';

// Slice 56N: classifier model lifecycle. Replaces the slice-56C cron
// bash chain with a durable workflow that supports admin-review signal
// pause and compensating actions on partial failure.
export {
  RetrainModelWorkflow,
  adminApprovalSignal,
  stepQuery,
} from '../modules/classifier-lifecycle/workflows/retrain-model.workflow.js';
export type {
  RetrainModelWorkflowInput,
  RetrainModelWorkflowOutput,
  AdminApprovalSignalPayload,
} from '../modules/classifier-lifecycle/workflows/retrain-model.workflow.js';

// Slice 57B: nightly retention GC. Replaces the in-process node gc.js
// script with three independently-retriable activities under one
// workflow. K8s CronJob now starts the workflow rather than running
// the work in-process.
export { CheckpointGcWorkflow } from '../modules/maintenance/workflows/checkpoint-gc.workflow.js';
export type {
  CheckpointGcWorkflowInput,
  CheckpointGcWorkflowOutput,
} from '../modules/maintenance/workflows/checkpoint-gc.workflow.js';

// Slice 58C: cross-queue extraction-strategy executor. Started by
// doc-service's runExtractionStrategyActivity on cip-hr-tasks; proxies
// the named extract-*-features activity locally and returns its result.
export { ExecuteExtractionStrategyWorkflow } from '../modules/certifications/workflows/execute-extraction-strategy.workflow.js';
export type { ExecuteExtractionStrategyInput } from '../modules/certifications/workflows/execute-extraction-strategy.workflow.js';

// Slice 58D-A: generic person-matcher workflow. Started as a child
// workflow by module workflows (cert today via 58D-B; future incident
// / training-enrollment / reminders) on the same cip-hr-tasks queue.
export {
  MatchPersonWorkflow,
  personPickedSignal,
} from '../modules/people/workflows/match-person.workflow.js';
