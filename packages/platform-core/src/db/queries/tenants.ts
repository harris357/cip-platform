import { eq, desc, sql } from 'drizzle-orm'
import { TenantSchema, type Tenant } from '@cip/shared/src/types/tenant.js'
import type { Db } from '../index.js'
import { tenants } from '../schema.js'

// Slice 63: drizzle-based tenant queries against cip_platform.tenants.
// Replaces hr-service/src/db/queries/tenants.ts (which is deleted in
// this slice).

function rowToTenant(row: typeof tenants.$inferSelect): Tenant {
  return TenantSchema.parse({
    id:           row.id,
    displayName:  row.displayName,
    status:       row.status,
    tier:         row.tier,
    adminEmail:   row.adminEmail,
    realm:        row.realm,
    createdAt:    row.createdAt.toString(),
    updatedAt:    row.updatedAt.toString(),
    suspendedAt:  row.suspendedAt ? row.suspendedAt.toString() : null,
    deletedAt:    row.deletedAt   ? row.deletedAt.toString()   : null,
  })
}

export async function findTenantById(db: Db, id: string): Promise<Tenant | null> {
  const rows = await db.select().from(tenants).where(eq(tenants.id, id)).limit(1)
  return rows[0] ? rowToTenant(rows[0]) : null
}

export async function listTenants(db: Db): Promise<Tenant[]> {
  const rows = await db.select().from(tenants).orderBy(desc(tenants.createdAt))
  return rows.map(rowToTenant)
}

export interface InsertTenantInput {
  id:          string
  displayName: string
  tier:        string
  adminEmail:  string
  realm?:      string  // defaults to id::text via SQL when omitted (matches prod architecture)
}

export async function insertTenant(db: Db, input: InsertTenantInput): Promise<Tenant> {
  const realm = input.realm ?? input.id
  const rows = await db
    .insert(tenants)
    .values({
      id:          input.id,
      displayName: input.displayName,
      tier:        input.tier,
      adminEmail:  input.adminEmail,
      realm,
    })
    .returning()
  return rowToTenant(rows[0]!)
}

export async function updateTenantStatus(
  db: Db,
  id: string,
  status: 'active' | 'suspended' | 'deleted',
): Promise<Tenant | null> {
  const setClause =
    status === 'suspended'
      ? { status, updatedAt: sql`NOW()`, suspendedAt: sql`NOW()` }
      : status === 'deleted'
      ? { status, updatedAt: sql`NOW()`, deletedAt: sql`NOW()` }
      : { status, updatedAt: sql`NOW()`, suspendedAt: null, deletedAt: null }
  const rows = await db
    .update(tenants)
    .set(setClause)
    .where(eq(tenants.id, id))
    .returning()
  return rows[0] ? rowToTenant(rows[0]) : null
}
