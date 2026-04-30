import type { PoolClient } from 'pg';
import { TenantSchema, type Tenant } from '@cip/shared/src/types/tenant.js';

const TENANT_COLUMNS = `
  id,
  display_name AS "displayName",
  status,
  tier,
  admin_email  AS "adminEmail",
  created_at   AS "createdAt",
  updated_at   AS "updatedAt",
  suspended_at AS "suspendedAt",
  deleted_at   AS "deletedAt"
`;

function rowToTenant(row: unknown): Tenant {
  const r = row as Record<string, unknown>;
  return TenantSchema.parse({
    id:           r['id'],
    displayName:  r['displayName'],
    status:       r['status'],
    tier:         r['tier'],
    adminEmail:   r['adminEmail'],
    createdAt:    (r['createdAt'] as Date | string).toString(),
    updatedAt:    (r['updatedAt'] as Date | string).toString(),
    suspendedAt:  r['suspendedAt'] ? (r['suspendedAt'] as Date | string).toString() : null,
    deletedAt:    r['deletedAt']   ? (r['deletedAt']   as Date | string).toString() : null,
  });
}

export async function findTenantById(client: PoolClient, id: string): Promise<Tenant | null> {
  const r = await client.query(`SELECT ${TENANT_COLUMNS} FROM tenants WHERE id = $1`, [id]);
  return r.rows[0] ? rowToTenant(r.rows[0]) : null;
}

export async function listTenants(client: PoolClient): Promise<Tenant[]> {
  const r = await client.query(
    `SELECT ${TENANT_COLUMNS} FROM tenants ORDER BY created_at DESC`,
  );
  return r.rows.map(rowToTenant);
}

export async function insertTenant(
  client: PoolClient,
  input: { id: string; displayName: string; tier: string; adminEmail: string },
): Promise<Tenant> {
  const r = await client.query(
    `INSERT INTO tenants (id, display_name, tier, admin_email)
     VALUES ($1, $2, $3, $4)
     RETURNING ${TENANT_COLUMNS}`,
    [input.id, input.displayName, input.tier, input.adminEmail],
  );
  return rowToTenant(r.rows[0]);
}

export async function updateTenantStatus(
  client: PoolClient,
  id: string,
  status: 'active' | 'suspended' | 'deleted',
): Promise<Tenant | null> {
  const setClause =
    status === 'suspended' ? `status = $2, suspended_at = NOW(), updated_at = NOW()` :
    status === 'deleted'   ? `status = $2, deleted_at   = NOW(), updated_at = NOW()` :
    `status = $2, suspended_at = NULL, deleted_at = NULL, updated_at = NOW()`;
  const r = await client.query(
    `UPDATE tenants SET ${setClause} WHERE id = $1 RETURNING ${TENANT_COLUMNS}`,
    [id, status],
  );
  return r.rows[0] ? rowToTenant(r.rows[0]) : null;
}
