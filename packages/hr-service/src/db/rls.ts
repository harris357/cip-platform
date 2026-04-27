import { sql } from 'drizzle-orm'
import type { Db } from './index.js'

export async function withTenantRLS<T>(
  db: Db,
  tenantId: string,
  fn: (tx: Db) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL app.current_tenant_id = ${tenantId}`)
    return fn(tx as unknown as Db)
  })
}
