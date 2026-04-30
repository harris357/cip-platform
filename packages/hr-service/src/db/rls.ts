import { sql } from 'drizzle-orm'
import type { Db } from './index.js'

export async function withTenantRLS<T>(
  db: Db,
  tenantId: string,
  fn: (tx: Db) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    // Postgres `SET LOCAL` does NOT accept bind parameters — using
    // `SET LOCAL ... = $1` produces a syntax error. set_config(key, value,
    // is_local=true) is the parameterized equivalent and is the supported
    // way to set a session GUC from user-supplied input.
    await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`)
    return fn(tx as unknown as Db)
  })
}
