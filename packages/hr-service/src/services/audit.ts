import { getPool } from '../db/index.js';
import { insertHrAction, type HrActionRecord } from '../db/queries/hr-actions.js';

/**
 * Slice 32: write a single HR audit row.
 *
 * Wraps RLS handling manually because `withTenantRLS` returns a Drizzle
 * transaction and `insertHrAction` uses raw `PoolClient` (matches the
 * admin-tenants.ts pattern). The RLS GUC is set inside a BEGIN/COMMIT so the
 * tenant_isolation policy on hr_actions accepts the INSERT.
 *
 * Errors writing audit are LOGGED but never thrown — losing the audit row
 * must not roll back the original action. Operationally, surface this via
 * a Prometheus alert on the [audit] log line. Not in scope here.
 */
export async function recordHrAction(rec: HrActionRecord): Promise<void> {
  const pool = getPool();
  let client;
  try {
    client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT set_config('app.current_tenant_id', $1, true)`,
        [rec.tenantId],
      );
      await insertHrAction(client, rec);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[audit] failed to write hr_actions row:', err, { rec });
  }
}
