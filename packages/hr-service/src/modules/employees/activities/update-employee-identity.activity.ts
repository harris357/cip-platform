import { z } from 'zod';
import { getPool } from '../../../db/index.js';
import { updateEmployeeIdentityType } from '../../../db/queries/employees-extra.js';

export interface UpdateEmployeeIdentityInput {
  tenantId:     string;
  employeeId:   string;
  identityType: 'aad_federated' | 'field_employee';
  aadOid:       string | null;
  phone:        string | null;
}

const OutputSchema = z.object({ ok: z.literal(true) });

export async function updateEmployeeIdentityActivity(
  input: UpdateEmployeeIdentityInput,
): Promise<{ ok: true }> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [input.tenantId]);
    await updateEmployeeIdentityType(
      client, input.tenantId, input.employeeId,
      input.identityType, input.aadOid, input.phone,
    );
    await client.query('COMMIT');
    return OutputSchema.parse({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
