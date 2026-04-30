import { z } from 'zod';
import { getPool } from '../../../db/index.js';
import { setEmployeeDisabledAt } from '../../../db/queries/employees-extra.js';

export interface UpdateEmployeeStatusInput {
  tenantId:   string;
  employeeId: string;
  active:     boolean;     // false => disabled (sets disabled_at = NOW); true => re-enable (clears it)
}

const OutputSchema = z.object({ ok: z.literal(true) });

export async function updateEmployeeStatusActivity(
  input: UpdateEmployeeStatusInput,
): Promise<{ ok: true }> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [input.tenantId]);
    await setEmployeeDisabledAt(
      client, input.tenantId, input.employeeId,
      input.active ? null : new Date(),
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
