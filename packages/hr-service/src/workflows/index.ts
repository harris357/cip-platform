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
