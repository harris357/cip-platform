import { createTemporalClient } from '@cip/shared/src/clients/temporal.js';
import { getPool } from '../db/index.js';
import { findEmployeeByKeycloakId } from '../db/queries/employees.js';
import { findEmployeeById } from '../db/queries/employees-extra.js';
import { recordHrAction } from './audit.js';
import { AppError } from './employee-onboarding.js';

export interface DisableEmployeeInput {
  tenantId:        string;
  actorKeycloakId: string;
  employeeId:      string;
  reason?:         string;
}

export interface DisableEmployeeResult {
  workflowId: string;
}

export async function disableEmployee(
  input: DisableEmployeeInput,
): Promise<DisableEmployeeResult> {
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
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  const temporal = await createTemporalClient(`${input.tenantId}.cip`);
  // Workflow ID pattern: {workflowType}-{tenantId}-{entityId}
  const workflowId = `EmployeeDisable-${input.tenantId}-${input.employeeId}`;
  try {
    await temporal.workflow.start('EmployeeDisableWorkflow', {
      taskQueue: process.env['TEMPORAL_TASK_QUEUE_HR'] ?? 'cip-hr-tasks',
      workflowId,
      args: [{
        tenantId:   input.tenantId,
        employeeId: input.employeeId,
        ...(input.reason ? { reason: input.reason } : {}),
      }],
    });
  } catch (err) {
    await recordHrAction({
      tenantId:         input.tenantId,
      actorEmployeeId,
      actionType:       'employee.disable',
      targetEmployeeId: input.employeeId,
      payload:          { reason: input.reason ?? null },
      result:           'failed',
      errorCode:        'workflow_start_failed',
      errorMessage:     err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  await recordHrAction({
    tenantId:         input.tenantId,
    actorEmployeeId,
    actionType:       'employee.disable',
    targetEmployeeId: input.employeeId,
    payload:          { reason: input.reason ?? null },
    result:           'success',
  });

  return { workflowId };
}
