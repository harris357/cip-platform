export { CertificationProcessingWorkflow, hitlDecisionSignal } from '../modules/certifications/workflows/certification-processing.workflow.js';
export { EmployeeOnboardingWorkflow } from '../modules/employees/workflows/employee-onboarding.workflow.js';
export type { EmployeeOnboardingInput } from '../modules/employees/workflows/employee-onboarding.workflow.js';

// Slice 33: identity migration + disable workflows
export { EmployeeIdentityMigrationWorkflow } from '../modules/employees/workflows/employee-identity-migration.workflow.js';
export type { EmployeeIdentityMigrationInput } from '../modules/employees/workflows/employee-identity-migration.workflow.js';

export { EmployeeDisableWorkflow } from '../modules/employees/workflows/employee-disable.workflow.js';
export type { EmployeeDisableInput } from '../modules/employees/workflows/employee-disable.workflow.js';
