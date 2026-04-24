import { Pool, PoolClient } from 'pg';

export function createPool(databaseUrl: string): Pool {
  return new Pool({ connectionString: databaseUrl });
}

export async function setTenantContext(client: PoolClient, tenantId: string): Promise<void> {
  await client.query(`SET app.current_tenant_id = $1`, [tenantId]);
}
