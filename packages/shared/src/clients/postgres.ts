import { Pool, PoolClient } from 'pg';

export function createPool(connectionString: string): Pool {
  return new Pool({ connectionString, max: 10 });
}

// Every DB query must go through this wrapper — sets RLS session variable before any query
export async function withTenantRLS<T>(
  client: PoolClient,
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  await client.query('SET app.current_tenant_id = $1', [tenantId]);
  try {
    return await fn(client);
  } finally {
    await client.query('RESET app.current_tenant_id');
  }
}
