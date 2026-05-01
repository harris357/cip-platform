import type { PoolClient } from 'pg';
import { listAllPermissionCodes } from './permission-catalog.js';

// Slice 42A: helper function names intentionally kept stable. Inner SQL
// targets the renamed tables (permission_groups, employee_group_assignments).
// Slice 42C swaps the inner SQL again to chain through the role layer; the
// helper names regain semantic accuracy then.

/**
 * Slice 38 + 42A: return the deduped, sorted list of permission codes the
 * given employee holds. 42A: queries the renamed tables and expands glob
 * entries (cert.*, *) against permission_catalog.
 *
 * Caller is responsible for setting the tenant RLS GUC; this function
 * just runs the JOIN.
 */
export async function getPermissionsForEmployee(
  client: PoolClient,
  employeeId: string,
): Promise<string[]> {
  const r = await client.query<{ p: string }>(
    `SELECT DISTINCT jsonb_array_elements_text(pg.permissions) AS p
       FROM employee_group_assignments ega
       JOIN permission_groups pg ON pg.id = ega.group_id
      WHERE ega.employee_id = $1`,
    [employeeId],
  );
  const raw = r.rows.map(row => row.p);

  const globs    = raw.filter(p => p.endsWith('*'));
  const literals = raw.filter(p => !p.endsWith('*'));
  if (globs.length === 0) return Array.from(new Set(literals)).sort();

  // Glob expansion — match against catalog.
  const allKnown = await listAllPermissionCodes(client);
  const expanded = new Set<string>(literals);
  for (const g of globs) {
    if (g === '*') {
      allKnown.forEach(p => expanded.add(p));
    } else {
      const prefix = g.slice(0, -1);   // 'cert.*' → 'cert.'
      allKnown.filter(p => p.startsWith(prefix)).forEach(p => expanded.add(p));
    }
  }
  return Array.from(expanded).sort();
}

/**
 * Slice 38 + 42A: return the group codes attached to the given employee.
 * Function name kept (Slice 42C reconciles).
 */
export async function getRoleCodesForEmployee(
  client: PoolClient,
  employeeId: string,
): Promise<string[]> {
  const r = await client.query<{ code: string }>(
    `SELECT pg.code
       FROM employee_group_assignments ega
       JOIN permission_groups pg ON pg.id = ega.group_id
      WHERE ega.employee_id = $1
      ORDER BY pg.code`,
    [employeeId],
  );
  return r.rows.map(row => row.code);
}

/**
 * Slice 38 + 42A: idempotently grant a group (by its code) to an employee.
 * Function name kept (Slice 42C reconciles).
 *
 * NB: the group is looked up by code only — if multiple groups share a code
 * across modules (allowed post-42A), this picks one arbitrarily. Callers
 * needing precise targeting should resolve the group_id first. For now,
 * every existing group has a unique code, so this works.
 */
export async function grantRoleByCode(
  client: PoolClient,
  tenantId: string,
  employeeId: string,
  roleCode: string,
  grantedBy: string | null,
): Promise<void> {
  await client.query(
    `INSERT INTO employee_group_assignments (employee_id, group_id, granted_by)
     SELECT $1, id, $4 FROM permission_groups
     WHERE tenant_id = $2 AND code = $3
     LIMIT 1
     ON CONFLICT DO NOTHING`,
    [employeeId, tenantId, roleCode, grantedBy],
  );
}

/**
 * Slice 38 + 42A: revoke a group (by code) from an employee. Idempotent.
 * Function name kept (Slice 42C reconciles).
 */
export async function revokeRoleByCode(
  client: PoolClient,
  tenantId: string,
  employeeId: string,
  roleCode: string,
): Promise<void> {
  await client.query(
    `DELETE FROM employee_group_assignments
       WHERE employee_id = $1
         AND group_id IN (
           SELECT id FROM permission_groups WHERE tenant_id = $2 AND code = $3
         )`,
    [employeeId, tenantId, roleCode],
  );
}

/**
 * Slice 38 + 42A: count distinct group codes assigned to an employee.
 * Used by employee.revoke_permission to refuse leaving a user role-less.
 * Function name kept (Slice 42C reconciles).
 */
export async function countRolesForEmployee(
  client: PoolClient,
  employeeId: string,
): Promise<number> {
  const r = await client.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM employee_group_assignments WHERE employee_id = $1`,
    [employeeId],
  );
  return parseInt(r.rows[0]?.n ?? '0', 10);
}
