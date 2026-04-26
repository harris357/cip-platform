import { createPool, withTenantRLS } from '@cip/shared/src/clients/postgres.js';

export async function initTenantDatabase(input: {
  tenantId: string;
  litellmVirtualKey: string;
}): Promise<void> {
  const pool = createPool(process.env['DATABASE_URL'] ?? '');
  const client = await pool.connect();
  try {
    // TODO: run 001_initial.sql and 002_domain_model.sql DDL migrations before this upsert
    await withTenantRLS(client, input.tenantId, async (c) => {
      await c.query(
        `INSERT INTO tenant_settings (tenant_id, litellm_virtual_key)
         VALUES ($1, $2)
         ON CONFLICT (tenant_id) DO UPDATE SET litellm_virtual_key = $2, updated_at = NOW()`,
        [input.tenantId, input.litellmVirtualKey],
      );
    });
  } finally {
    client.release();
    await pool.end();
  }
}
