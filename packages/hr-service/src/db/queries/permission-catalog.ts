import type { PoolClient } from 'pg';

export interface CatalogEntry {
  service:     string;
  module:      string;
  permission:  string;
  description: string | null;
}

/**
 * Slice 42A: list permission catalog entries, optionally filtered by
 * service and/or module. Returned sorted alphabetically by permission code
 * (the natural display order).
 */
export async function listCatalogEntries(
  client: PoolClient,
  filter: { service?: string; module?: string } = {},
): Promise<CatalogEntry[]> {
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.service) { where.push(`service = $${args.length + 1}`); args.push(filter.service); }
  if (filter.module)  { where.push(`module  = $${args.length + 1}`); args.push(filter.module); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const r = await client.query<CatalogEntry>(
    `SELECT service, module, permission, description
       FROM cip_platform.permission_catalog
       ${whereSql}
       ORDER BY service, module, permission`,
    args,
  );
  return r.rows;
}

/**
 * Slice 42A: list all known permission codes (sorted, no metadata).
 * Used by the glob-expansion path in getPermissionsForEmployee.
 */
export async function listAllPermissionCodes(client: PoolClient): Promise<string[]> {
  const r = await client.query<{ permission: string }>(
    `SELECT permission FROM cip_platform.permission_catalog ORDER BY permission`,
  );
  return r.rows.map(row => row.permission);
}
