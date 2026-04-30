import { proxyActivities } from '@temporalio/workflow';
import type * as activities from '../activities/index.js';

type IdentityType = 'aad_federated' | 'field_employee';

export interface EmployeeIdentityMigrationInput {
  tenantId:           string;
  employeeId:         string;
  targetIdentityType: IdentityType;
  aadOid?:            string;
  phone?:             string;
}

const {
  validateMigrationPreconditionsActivity,
  attachAadFederationActivity,
  detachAadFederationActivity,
  clearLocalCredentialsActivity,
  setupOtpRequiredActionsActivity,
  updateEmployeeIdentityActivity,
  invalidateUserSessionsActivity,
  sendIdentityChangedNotificationActivity,
} = proxyActivities<typeof activities>({
  startToCloseTimeout: '5 minutes',
  retry: { maximumAttempts: 3 },
});

export async function EmployeeIdentityMigrationWorkflow(
  input: EmployeeIdentityMigrationInput,
): Promise<void> {
  // Workflow ID pattern: {workflowType}-{tenantId}-{entityId}
  // workflowId: `EmployeeMigrate-${input.tenantId}-${input.employeeId}`

  const { keycloakId, currentIdentityType } = await validateMigrationPreconditionsActivity({
    tenantId:           input.tenantId,
    employeeId:         input.employeeId,
    targetIdentityType: input.targetIdentityType,
  });

  if (input.targetIdentityType === 'aad_federated') {
    if (!input.aadOid) throw new Error('aadOid required for aad_federated migration');
    await attachAadFederationActivity({
      tenantId:   input.tenantId,
      keycloakId,
      aadOid:     input.aadOid,
      email:      '',  // optional in KC; the federation row lookup uses userId only
    });
    await clearLocalCredentialsActivity({ tenantId: input.tenantId, keycloakId });
  } else {
    if (!input.phone) throw new Error('phone required for field_employee migration');
    await detachAadFederationActivity({ tenantId: input.tenantId, keycloakId });
    await setupOtpRequiredActionsActivity({
      tenantId:   input.tenantId,
      keycloakId,
      phone:      input.phone,
    });
  }

  await updateEmployeeIdentityActivity({
    tenantId:     input.tenantId,
    employeeId:   input.employeeId,
    identityType: input.targetIdentityType,
    aadOid:       input.aadOid ?? null,
    phone:        input.phone  ?? null,
  });

  await invalidateUserSessionsActivity({ tenantId: input.tenantId, keycloakId });

  await sendIdentityChangedNotificationActivity({
    tenantId:    input.tenantId,
    employeeId:  input.employeeId,
    fromType:    currentIdentityType,
    toType:      input.targetIdentityType,
  });
}
