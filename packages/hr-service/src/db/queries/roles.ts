import type { PoolClient } from 'pg';
import { listAllPermissionCodes } from './permission-catalog.js';

// Slice 42C: role-layer query helpers. Roles are CIP business-concept
// "job functions" composed of module-scoped permission_groups via role_groups.
// Employees are assigned to roles via employee_role_assignments.

export interface Role {
  id:            string;
  tenantId:      string;
  code:          string;
  label:         string;
  description:   string | null;
  keycloakRole:  string;
  isSystemRole:  boolean;
}

export interface RoleSummary extends Role {
  groupCount: number;
}

export interface PermissionGroup {
  id:            string;
  tenantId:      string;
  service:       string;
  module:        string;
  code:          string;
  label:         string;
  description:   string | null;
  permissions:   string[];      // raw, may include globs
  isSystemRole:  boolean;
}

export interface EmployeeSummary {
  id:        string;
  tenantId:  string;
  email:     string;
  fullName:  string;
}

// ─── Role assignment (replaces 42A's grantRoleByCode/revokeRoleByCode) ───────

/**
 * Slice 42C: assign a role to an employee by role code. Idempotent.
 */
export async function assignRoleToEmployee(
  client: PoolClient,
  tenantId: string,
  employeeId: string,
  roleCode: string,
  grantedBy: string | null,
): Promise<void> {
  await client.query(
    `INSERT INTO employee_role_assignments (employee_id, role_id, granted_by)
     SELECT $1, id, $4 FROM roles WHERE tenant_id = $2 AND code = $3
     ON CONFLICT DO NOTHING`,
    [employeeId, tenantId, roleCode, grantedBy],
  );
}

/**
 * Slice 42C: revoke a role from an employee. Idempotent.
 */
export async function removeRoleFromEmployee(
  client: PoolClient,
  tenantId: string,
  employeeId: string,
  roleCode: string,
): Promise<void> {
  await client.query(
    `DELETE FROM employee_role_assignments
       WHERE employee_id = $1
         AND role_id IN (SELECT id FROM roles WHERE tenant_id = $2 AND code = $3)`,
    [employeeId, tenantId, roleCode],
  );
}

// ─── Read helpers used by admin MCP tools ────────────────────────────────────

export async function listRolesByTenant(
  client: PoolClient,
  tenantId: string,
): Promise<RoleSummary[]> {
  const r = await client.query<{
    id: string; tenantId: string; code: string; label: string;
    description: string | null; keycloakRole: string; isSystemRole: boolean;
    groupCount: string;
  }>(
    `SELECT r.id,
            r.tenant_id      AS "tenantId",
            r.code,
            r.label,
            r.description,
            r.keycloak_role  AS "keycloakRole",
            r.is_system_role AS "isSystemRole",
            COUNT(rg.group_id)::text AS "groupCount"
       FROM roles r
       LEFT JOIN role_groups rg ON rg.role_id = r.id
      WHERE r.tenant_id = $1
      GROUP BY r.id
      ORDER BY r.code`,
    [tenantId],
  );
  return r.rows.map(row => ({ ...row, groupCount: parseInt(row.groupCount, 10) }));
}

export async function findRoleByCode(
  client: PoolClient,
  tenantId: string,
  code: string,
): Promise<Role | null> {
  const r = await client.query<Role>(
    `SELECT id,
            tenant_id      AS "tenantId",
            code, label, description,
            keycloak_role  AS "keycloakRole",
            is_system_role AS "isSystemRole"
       FROM roles WHERE tenant_id = $1 AND code = $2 LIMIT 1`,
    [tenantId, code],
  );
  return r.rows[0] ?? null;
}

export async function listGroupsForRole(
  client: PoolClient,
  roleId: string,
): Promise<PermissionGroup[]> {
  const r = await client.query<PermissionGroup>(
    `SELECT pg.id,
            pg.tenant_id      AS "tenantId",
            pg.service,
            pg.module,
            pg.code,
            pg.label,
            pg.description,
            pg.permissions,
            pg.is_system_role AS "isSystemRole"
       FROM role_groups rg
       JOIN permission_groups pg ON pg.id = rg.group_id
      WHERE rg.role_id = $1
      ORDER BY pg.module, pg.code`,
    [roleId],
  );
  return r.rows;
}

export async function listEmployeesForRole(
  client: PoolClient,
  roleId: string,
): Promise<EmployeeSummary[]> {
  const r = await client.query<EmployeeSummary>(
    `SELECT e.id,
            e.tenant_id AS "tenantId",
            e.email,
            e.full_name AS "fullName"
       FROM employee_role_assignments era
       JOIN employees e ON e.id = era.employee_id
      WHERE era.role_id = $1
      ORDER BY e.email`,
    [roleId],
  );
  return r.rows;
}

export async function listGroupsByTenant(
  client: PoolClient,
  tenantId: string,
  module?: string,
): Promise<PermissionGroup[]> {
  const where: string[] = ['tenant_id = $1'];
  const args: unknown[] = [tenantId];
  if (module) {
    where.push(`module = $${args.length + 1}`);
    args.push(module);
  }
  const r = await client.query<PermissionGroup>(
    `SELECT id,
            tenant_id      AS "tenantId",
            service, module, code, label, description,
            permissions,
            is_system_role AS "isSystemRole"
       FROM permission_groups
      WHERE ${where.join(' AND ')}
      ORDER BY service, module, code`,
    args,
  );
  return r.rows;
}

export async function findGroupByCode(
  client: PoolClient,
  tenantId: string,
  module: string,
  code: string,
): Promise<PermissionGroup | null> {
  const r = await client.query<PermissionGroup>(
    `SELECT id,
            tenant_id      AS "tenantId",
            service, module, code, label, description,
            permissions,
            is_system_role AS "isSystemRole"
       FROM permission_groups
      WHERE tenant_id = $1 AND module = $2 AND code = $3
      LIMIT 1`,
    [tenantId, module, code],
  );
  return r.rows[0] ?? null;
}

export async function listRolesContainingGroup(
  client: PoolClient,
  groupId: string,
): Promise<Role[]> {
  const r = await client.query<Role>(
    `SELECT r.id,
            r.tenant_id      AS "tenantId",
            r.code, r.label, r.description,
            r.keycloak_role  AS "keycloakRole",
            r.is_system_role AS "isSystemRole"
       FROM role_groups rg
       JOIN roles r ON r.id = rg.role_id
      WHERE rg.group_id = $1
      ORDER BY r.code`,
    [groupId],
  );
  return r.rows;
}

/**
 * Slice 42C: expand a permission_group's `permissions` JSONB against the
 * catalog. Used by `group_get` to show what a group ACTUALLY grants vs
 * what's stored as glob entries. Same logic as `getPermissionsForEmployee`
 * but for a single group.
 */
export async function expandGroupPermissions(
  client: PoolClient,
  group: PermissionGroup,
): Promise<string[]> {
  const raw = Array.isArray(group.permissions) ? group.permissions : [];
  const globs    = raw.filter(p => typeof p === 'string' && p.endsWith('*'));
  const literals = raw.filter(p => typeof p === 'string' && !p.endsWith('*'));
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

// ─── Cross-cutting: who has permission X? ────────────────────────────────────

/**
 * Slice 42C: list employees holding a specific permission. Matches
 * literals AND globs that COVER the queried permission:
 *   `cert.approve` is held by anyone with literal 'cert.approve',
 *   the prefix-glob 'cert.*', or the all-glob '*'.
 */
export async function listEmployeesWithPermission(
  client: PoolClient,
  tenantId: string,
  permission: string,
): Promise<EmployeeSummary[]> {
  const prefix = permission.includes('.')
    ? permission.split('.')[0] + '.*'
    : '*';
  const r = await client.query<EmployeeSummary>(
    `SELECT DISTINCT e.id,
            e.tenant_id AS "tenantId",
            e.email,
            e.full_name AS "fullName"
       FROM employees e
       JOIN employee_role_assignments era ON era.employee_id = e.id
       JOIN role_groups rg                ON rg.role_id      = era.role_id
       JOIN permission_groups pg          ON pg.id           = rg.group_id
       JOIN jsonb_array_elements_text(pg.permissions) AS p ON true
      WHERE e.tenant_id = $1
        AND (p = $2 OR p = $3 OR p = '*')
      ORDER BY e.email`,
    [tenantId, permission, prefix],
  );
  return r.rows;
}
