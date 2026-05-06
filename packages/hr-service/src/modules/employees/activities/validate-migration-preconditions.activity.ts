import { z } from 'zod';
import { getDb, getPool } from '../../../db/index.js';
import { findEmployeeById } from '../../../db/queries/employees-extra.js';
import { findEmployeeWithUser } from '../../../db/queries/employee-with-user.js';
import { getKeycloakSubject } from '../../../db/queries/identity-links.js';
import { withTenantRLS } from '../../../db/rls.js';

export interface ValidateMigrationPreconditionsInput {
  tenantId:           string;
  employeeId:         string;
  targetIdentityType: 'aad_federated' | 'field_employee';
}

export interface ValidateMigrationPreconditionsOutput {
  keycloakId:          string;
  currentIdentityType: 'aad_federated' | 'field_employee';
}

const OutputSchema = z.object({
  keycloakId:          z.string().min(1),
  currentIdentityType: z.enum(['aad_federated', 'field_employee']),
});

export async function validateMigrationPreconditionsActivity(
  input: ValidateMigrationPreconditionsInput,
): Promise<ValidateMigrationPreconditionsOutput> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [input.tenantId]);
    const emp = await findEmployeeById(client, input.tenantId, input.employeeId);
    await client.query('COMMIT');
    if (!emp) throw new Error(`employee ${input.employeeId} not found in tenant ${input.tenantId}`);

    // Slice 65: identity moved to cip_platform.users + user_identity_links.
    const db = getDb();
    const eu = await withTenantRLS(db, input.tenantId, (tx) =>
      findEmployeeWithUser(tx, input.tenantId, input.employeeId),
    );
    if (!eu) throw new Error(`employee ${input.employeeId} has no user record`);
    const keycloakId = await withTenantRLS(db, input.tenantId, (tx) => getKeycloakSubject(tx, emp.userId));
    if (!keycloakId) throw new Error(`employee ${input.employeeId} has no keycloak identity link; onboarding incomplete`);
    if (eu.user.identityType === input.targetIdentityType) {
      throw new Error(`employee already has identity_type=${input.targetIdentityType} — no-op migration`);
    }
    return OutputSchema.parse({
      keycloakId,
      currentIdentityType: eu.user.identityType,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
