import { createTemporalClient } from '@cip/shared/src/clients/temporal.js';
import { getPool } from '../db/index.js';
import { findEmployeeByKeycloakId, findEmployeeByEmail } from '../db/queries/employees.js';
import { findEmployeeById } from '../db/queries/employees-extra.js';
import { recordHrAction } from './audit.js';
import { AppError } from './employee-onboarding.js';

export interface MigrateIdentityInput {
  tenantId:           string;
  actorKeycloakId:    string;
  employeeId:         string;
  targetIdentityType: 'aad_federated' | 'field_employee';
  aadOid?:            string;
  phone?:             string;
}

export interface MigrateIdentityResult {
  workflowId: string;
}

export async function migrateEmployeeIdentity(
  input: MigrateIdentityInput,
): Promise<MigrateIdentityResult> {
  // Validate the conditional field present.
  if (input.targetIdentityType === 'aad_federated' && !input.aadOid) {
    throw new AppError('missing_required_field', 422, 'aadOid required for aad_federated target');
  }
  if (input.targetIdentityType === 'field_employee' && !input.phone) {
    throw new AppError('missing_required_field', 422, 'phone required for field_employee target');
  }

  // Resolve actor + target + no-op check inside one tenant-scoped tx.
  const pool = getPool();
  const client = await pool.connect();
  let actorEmployeeId: string;
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [input.tenantId]);
    const actor = await findEmployeeByKeycloakId(client, input.tenantId, input.actorKeycloakId);
    if (!actor) {
      throw new AppError('actor_not_provisioned', 403, 'caller is not provisioned as an employee');
    }
    actorEmployeeId = actor.id;

    const target = await findEmployeeById(client, input.tenantId, input.employeeId);
    if (!target) {
      throw new AppError('not_found', 404, `employee ${input.employeeId} not found`);
    }
    if (target.identityType === input.targetIdentityType) {
      throw new AppError('migration_no_op', 409, 'target identity_type matches current');
    }

    // For AAD target: ensure email->existing-employee uniqueness if oid creates a new login;
    // we don't change email here, so this is just for completeness — kept simple.
    // (Slice 33's full uniqueness enforcement is captured by the underlying activities.)
    void findEmployeeByEmail;  // imported for symmetry; not used in this path

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  // Fire the workflow.
  const temporal = await createTemporalClient(`${input.tenantId}.cip`);
  // Workflow ID pattern: {workflowType}-{tenantId}-{entityId}
  const workflowId = `EmployeeMigrate-${input.tenantId}-${input.employeeId}`;
  try {
    await temporal.workflow.start('EmployeeIdentityMigrationWorkflow', {
      taskQueue: process.env['TEMPORAL_TASK_QUEUE_HR'] ?? 'cip-hr-tasks',
      workflowId,
      args: [{
        tenantId:           input.tenantId,
        employeeId:         input.employeeId,
        targetIdentityType: input.targetIdentityType,
        ...(input.aadOid ? { aadOid: input.aadOid } : {}),
        ...(input.phone  ? { phone:  input.phone }  : {}),
      }],
    });
  } catch (err) {
    await recordHrAction({
      tenantId:         input.tenantId,
      actorEmployeeId,
      actionType:       'employee.migrate_identity',
      targetEmployeeId: input.employeeId,
      payload:          { targetIdentityType: input.targetIdentityType },
      result:           'failed',
      errorCode:        'workflow_start_failed',
      errorMessage:     err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  await recordHrAction({
    tenantId:         input.tenantId,
    actorEmployeeId,
    actionType:       'employee.migrate_identity',
    targetEmployeeId: input.employeeId,
    payload: {
      targetIdentityType: input.targetIdentityType,
      aadOidPresent:      !!input.aadOid,
      phonePresent:       !!input.phone,
    },
    result: 'success',
  });

  return { workflowId };
}
