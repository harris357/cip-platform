import { z } from 'zod';
import { getDb, getPool } from '../../../db/index.js';
import { findEmployeeById } from '../../../db/queries/employees-extra.js';
import { getKeycloakSubject } from '../../../db/queries/identity-links.js';
import { withTenantRLS } from '../../../db/rls.js';
import { getKcAdmin, kcAdminRequest } from '../../../services/keycloak-admin.js';

export interface DisableKeycloakUserInput {
  tenantId:   string;
  employeeId: string;
}

export interface DisableKeycloakUserOutput {
  keycloakId: string;
}

const OutputSchema = z.object({ keycloakId: z.string().min(1) });

export async function disableKeycloakUserActivity(
  input: DisableKeycloakUserInput,
): Promise<DisableKeycloakUserOutput> {
  // Resolve keycloakId from the employees row.
  const pool = getPool();
  const client = await pool.connect();
  let keycloakId: string;
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [input.tenantId]);
    const emp = await findEmployeeById(client, input.tenantId, input.employeeId);
    await client.query('COMMIT');
    if (!emp) throw new Error(`employee ${input.employeeId} not found`);
    // Slice 65: keycloak subject moved to user_identity_links.
    const kc = await withTenantRLS(getDb(), input.tenantId, (tx) => getKeycloakSubject(tx, emp.userId));
    if (!kc) throw new Error(`employee ${input.employeeId} has no keycloak identity link`);
    keycloakId = kc;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  // Set enabled=false on the KC user.
  const admin = await getKcAdmin(input.tenantId);
  const userResp = await kcAdminRequest(admin, 'GET', `/users/${keycloakId}`);
  if (!userResp.ok) throw new Error(`disableKeycloakUser: GET user HTTP ${userResp.status}`);
  const user = (await userResp.json()) as Record<string, unknown>;
  user['enabled'] = false;
  const putResp = await kcAdminRequest(admin, 'PUT', `/users/${keycloakId}`, user);
  if (!putResp.ok) {
    throw new Error(`disableKeycloakUser: PUT user HTTP ${putResp.status} ${await putResp.text()}`);
  }

  return OutputSchema.parse({ keycloakId });
}
