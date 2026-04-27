import { proxyActivities } from '@temporalio/workflow';
import type * as activities from '../activities/index.js';

type IdentityType = 'aad_federated' | 'field_employee';

export interface EmployeeOnboardingInput {
  tenantId:     string;
  employeeId:   string;
  identityType: IdentityType;
  email:        string;
  fullName:     string;
  aadOid?:      string;
}

const {
  createKeycloakUserActivity,
  assignDefaultRoleActivity,
  sendWelcomeNotificationActivity,
  publishEmployeeOnboardedActivity,
} = proxyActivities<typeof activities>({
  startToCloseTimeout: '5 minutes',
  retry: { maximumAttempts: 3 },
});

export async function EmployeeOnboardingWorkflow(
  input: EmployeeOnboardingInput,
): Promise<void> {
  // Workflow ID pattern: {workflowType}-{tenantId}-{entityId}
  // workflowId: `EmployeeOnboard-${input.tenantId}-${input.employeeId}`

  await createKeycloakUserActivity({
    tenantId:     input.tenantId,
    employeeId:   input.employeeId,
    identityType: input.identityType,
    email:        input.email,
    fullName:     input.fullName,
    ...(input.aadOid !== undefined ? { aadOid: input.aadOid } : {}),
  });

  await assignDefaultRoleActivity({
    tenantId:     input.tenantId,
    employeeId:   input.employeeId,
    identityType: input.identityType,
  });

  await sendWelcomeNotificationActivity({
    tenantId:     input.tenantId,
    employeeId:   input.employeeId,
    identityType: input.identityType,
  });

  await publishEmployeeOnboardedActivity({
    tenantId:     input.tenantId,
    employeeId:   input.employeeId,
    identityType: input.identityType,
  });
}
