import type { PoolClient } from 'pg';
import { listAllPermissionCodes } from './permission-catalog.js';
import {
  assignRoleToEmployee,
  removeRoleFromEmployee,
} from './roles.js';

// Slice 42C: helpers below now chain through the role layer
//   employee → role → groups → permissions
// Function names regain semantic accuracy — `grantRoleByCode` and
// `revokeRoleByCode` actually grant/revoke ROLES now, since 42C made
// roles the unit of assignment. They proxy to the roles.ts canonical
// helpers (`assignRoleToEmployee` / `removeRoleFromEmployee`) — both
// names exported so callers can use whichever feels right.

/**
 * Slice 38 + 42A + 42C: deduped, sorted permission codes the given
 * employee holds. Chained resolver:
 *   employee_role_assignments → role_groups → permission_groups
 * Glob entries (cert.*, *) expand against permission_catalog at the leaf.
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
       FROM employee_role_assignments era
       JOIN role_groups rg            ON rg.role_id  = era.role_id
       JOIN permission_groups pg      ON pg.id       = rg.group_id
      WHERE era.employee_id = $1`,
    [employeeId],
  );
  const raw = r.rows.map(row => row.p);

  const globs    = raw.filter(p => p.endsWith('*'));
  const literals = raw.filter(p => !p.endsWith('*'));
  if (globs.length === 0) return Array.from(new Set(literals)).sort();

  const allKnown = await listAllPermissionCodes(client);
  const expanded = new Set<string>(literals);
  for (const g of globs) {
    if (g === '*') {
      allKnown.forEach(p => expanded.add(p));
    } else {
      const prefix = g.slice(0, -1);
      allKnown.filter(p => p.startsWith(prefix)).forEach(p => expanded.add(p));
    }
  }
  return Array.from(expanded).sort();
}

/**
 * Slice 42C: return the role codes attached to the given employee.
 * (Pre-42C this read group codes directly from employee_group_assignments.)
 */
export async function getRoleCodesForEmployee(
  client: PoolClient,
  employeeId: string,
): Promise<string[]> {
  const r = await client.query<{ code: string }>(
    `SELECT r.code
       FROM employee_role_assignments era
       JOIN roles r ON r.id = era.role_id
      WHERE era.employee_id = $1
      ORDER BY r.code`,
    [employeeId],
  );
  return r.rows.map(row => row.code);
}

/**
 * Slice 38 + 42C: idempotently grant a role (by code) to an employee.
 * Proxies to assignRoleToEmployee in roles.ts. Both names are kept so
 * existing callers don't need a rename in the same slice.
 */
export async function grantRoleByCode(
  client: PoolClient,
  tenantId: string,
  employeeId: string,
  roleCode: string,
  grantedBy: string | null,
): Promise<void> {
  await assignRoleToEmployee(client, tenantId, employeeId, roleCode, grantedBy);
}

/**
 * Slice 38 + 42C: revoke a role (by code) from an employee. Proxy.
 */
export async function revokeRoleByCode(
  client: PoolClient,
  tenantId: string,
  employeeId: string,
  roleCode: string,
): Promise<void> {
  await removeRoleFromEmployee(client, tenantId, employeeId, roleCode);
}

/**
 * Slice 38 + 42C: count distinct roles assigned to an employee.
 * Used by employee.revoke_permission to refuse leaving a user role-less.
 */
export async function countRolesForEmployee(
  client: PoolClient,
  employeeId: string,
): Promise<number> {
  const r = await client.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM employee_role_assignments WHERE employee_id = $1`,
    [employeeId],
  );
  return parseInt(r.rows[0]?.n ?? '0', 10);
}
