import { proxyActivities } from '@temporalio/workflow';
import type * as activities from '../activities/index.js';

export interface EmployeeDisableInput {
  tenantId:   string;
  employeeId: string;
  reason?:    string;
}

const {
  disableKeycloakUserActivity,
  invalidateUserSessionsActivity,
  updateEmployeeStatusActivity,
} = proxyActivities<typeof activities>({
  startToCloseTimeout: '5 minutes',
  retry: { maximumAttempts: 3 },
});

export async function EmployeeDisableWorkflow(
  input: EmployeeDisableInput,
): Promise<void> {
  // Workflow ID pattern: {workflowType}-{tenantId}-{entityId}
  // workflowId: `EmployeeDisable-${input.tenantId}-${input.employeeId}`

  const { keycloakId } = await disableKeycloakUserActivity({
    tenantId:   input.tenantId,
    employeeId: input.employeeId,
  });

  await invalidateUserSessionsActivity({
    tenantId:   input.tenantId,
    keycloakId,
  });

  await updateEmployeeStatusActivity({
    tenantId:   input.tenantId,
    employeeId: input.employeeId,
    active:     false,
  });
}
