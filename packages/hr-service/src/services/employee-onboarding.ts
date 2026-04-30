import { randomUUID } from 'node:crypto';
import { createTemporalClient } from '@cip/shared/src/clients/temporal.js';
import { getPool } from '../db/index.js';
import { upsertEmployee, findEmployeeByEmail, findEmployeeByKeycloakId } from '../db/queries/employees.js';
import { recordHrAction } from './audit.js';
import {
  IdentityTypeSchema,
  EmploymentTypeSchema,
  type IdentityType,
  type EmploymentType,
} from '../types/employee.js';

/**
 * Typed application error — the route handler maps `code` and `status`
 * to the HTTP response. Throwing one of these from inside onboardEmployee
 * lets the route catch and respond cleanly without baking HTTP semantics
 * into the service layer.
 */
export class AppError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export interface OnboardEmployeeInput {
  tenantId:        string;
  actorKeycloakId: string;            // sub from caller's JWT — resolved to employees.id internally
  email:           string;
  fullName:        string;
  identityType:    IdentityType;
  aadOid?:         string;
  phone?:          string;
  employmentType?: EmploymentType;
}

export interface OnboardEmployeeResult {
  employeeId: string;
  workflowId: string;
}

/**
 * Slice 31: provision an employee row + fire EmployeeOnboardingWorkflow.
 *
 * Shared by the HTTP route (POST /admin/employees) and (in Slice 33) the
 * employee.create MCP tool — single source of truth for onboarding logic.
 *
 * Auditing: writes an hr_actions row on every call, success or failure.
 * Failure paths use AppError with stable codes so the HTTP route can map
 * them to the right status without sniffing message text.
 */
export async function onboardEmployee(
  input: OnboardEmployeeInput,
): Promise<OnboardEmployeeResult> {
  // 1. Conditional-required fields by identityType
  if (input.identityType === 'aad_federated' && !input.aadOid) {
    const err = new AppError(
      'missing_required_field',
      422,
      'aadOid is required when identityType=aad_federated',
    );
    await recordFailedAction(input, null, err);
    throw err;
  }
  if (input.identityType === 'field_employee' && !input.phone) {
    const err = new AppError(
      'missing_required_field',
      422,
      'phone is required when identityType=field_employee',
    );
    await recordFailedAction(input, null, err);
    throw err;
  }

  const id = randomUUID();
  const email = input.email.toLowerCase();
  const employmentType: EmploymentType = input.employmentType ?? 'employee';

  const pool = getPool();
  let actorEmployeeId: string | null = null;
  let client;
  try {
    client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT set_config('app.current_tenant_id', $1, true)`,
        [input.tenantId],
      );

      // Resolve actor employees.id from the caller's KC sub. The hr_actions
      // table requires a real employee row as the actor.
      const actor = await findEmployeeByKeycloakId(client, input.tenantId, input.actorKeycloakId);
      if (!actor) {
        throw new AppError(
          'actor_not_provisioned',
          403,
          'caller is not provisioned as an employee in this tenant — cannot record HR action',
        );
      }
      actorEmployeeId = actor.id;

      // Duplicate check before workflow start (returns clean 409 instead of
      // letting the unique-constraint surface as an opaque DB error).
      const existing = await findEmployeeByEmail(client, input.tenantId, email);
      if (existing) {
        throw new AppError(
          'duplicate_email',
          409,
          `an employee with email ${email} already exists in this tenant`,
        );
      }

      // Insert employees row. keycloak_id is null until the workflow's
      // createKeycloakUserActivity completes; a future activity (Slice 31
      // optional follow-up) writes it back.
      await upsertEmployee(client, {
        id,
        tenantId:       input.tenantId,
        email,
        fullName:       input.fullName,
        identityType:   IdentityTypeSchema.parse(input.identityType),
        employmentType: EmploymentTypeSchema.parse(employmentType),
        aadOid:         input.aadOid    ?? null,
        phone:          input.phone     ?? null,
        keycloakId:     null,
      });

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    await recordFailedAction(input, actorEmployeeId, err);
    throw err;
  }

  // 2. Start the existing onboarding workflow.
  const temporal = await createTemporalClient(`${input.tenantId}.cip`);
  // Workflow ID pattern: {workflowType}-{tenantId}-{entityId}
  const workflowId = `EmployeeOnboard-${input.tenantId}-${id}`;
  try {
    await temporal.workflow.start('EmployeeOnboardingWorkflow', {
      taskQueue: process.env['TEMPORAL_TASK_QUEUE_HR'] ?? 'cip-hr-tasks',
      workflowId,
      args: [{
        tenantId:     input.tenantId,
        employeeId:   id,
        identityType: input.identityType,
        email,
        fullName:     input.fullName,
        ...(input.aadOid ? { aadOid: input.aadOid } : {}),
      }],
    });
  } catch (err) {
    await recordFailedAction(input, actorEmployeeId, err, id);
    throw err instanceof AppError
      ? err
      : new AppError('workflow_start_failed', 500, err instanceof Error ? err.message : String(err));
  }

  // 3. Audit success
  await recordHrAction({
    tenantId:         input.tenantId,
    actorEmployeeId:  actorEmployeeId!,
    actionType:       'employee.create',
    targetEmployeeId: id,
    payload: {
      email,
      fullName:     input.fullName,
      identityType: input.identityType,
      aadOidPresent: !!input.aadOid,
      phonePresent:  !!input.phone,
      employmentType,
    },
    result: 'success',
  });

  return { employeeId: id, workflowId };
}

async function recordFailedAction(
  input:           OnboardEmployeeInput,
  actorEmployeeId: string | null,
  err:             unknown,
  targetEmployeeId?: string,
): Promise<void> {
  // If we couldn't resolve the actor, we can't satisfy actor_employee_id NOT NULL —
  // skip auditing rather than crash. The original error still propagates.
  if (!actorEmployeeId) return;
  const errorCode    = err instanceof AppError ? err.code : 'internal';
  const errorMessage = err instanceof Error    ? err.message : String(err);
  await recordHrAction({
    tenantId:        input.tenantId,
    actorEmployeeId,
    actionType:      'employee.create',
    ...(targetEmployeeId ? { targetEmployeeId } : {}),
    payload: {
      email:        input.email.toLowerCase(),
      fullName:     input.fullName,
      identityType: input.identityType,
    },
    result:       'failed',
    errorCode,
    errorMessage,
  });
}
