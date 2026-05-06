import type { PoolClient } from 'pg';
import { listAllPermissionCodes } from './permission-catalog.js';

// Slice 68: authorization tables moved to cip_platform. Raw SQL prefixed
// with cip_platform.* explicitly. Column rename: employee_role_assignments.
// employee_id → user_role_assignments.user_id (1:1 from slice 64).
// permission_groups.is_system_role → permission_groups.is_system.
// EmployeeSummary now resolves email/full_name via cip_platform.users JOIN.

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
  isSystemRole:  boolean;       // sourced from is_system column post-slice-68
}

export interface EmployeeSummary {
  id:        string;
  tenantId:  string;
  email:     string;
  fullName:  string;
}

// ─── Role assignment ────────────────────────────────────────────────────────

/**
 * Slice 68: assign a role to a user by role code. Idempotent.
 */
export async function assignRoleToEmployee(
  client: PoolClient,
  tenantId: string,
  employeeId: string,   // == userId (slice 64 1:1)
  roleCode: string,
  grantedBy: string | null,
): Promise<void> {
  await client.query(
    `INSERT INTO cip_platform.user_role_assignments (user_id, role_id, tenant_id, granted_by)
     SELECT $1, id, $2, $4 FROM cip_platform.roles WHERE tenant_id = $2 AND code = $3
     ON CONFLICT DO NOTHING`,
    [employeeId, tenantId, roleCode, grantedBy],
  );
}

/**
 * Slice 68: revoke a role from a user. Idempotent.
 */
export async function removeRoleFromEmployee(
  client: PoolClient,
  tenantId: string,
  employeeId: string,
  roleCode: string,
): Promise<void> {
  await client.query(
    `DELETE FROM cip_platform.user_role_assignments
       WHERE user_id = $1
         AND role_id IN (SELECT id FROM cip_platform.roles WHERE tenant_id = $2 AND code = $3)`,
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
       FROM cip_platform.roles r
       LEFT JOIN cip_platform.role_groups rg ON rg.role_id = r.id
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
       FROM cip_platform.roles WHERE tenant_id = $1 AND code = $2 LIMIT 1`,
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
            pg.tenant_id     AS "tenantId",
            pg.service,
            pg.module,
            pg.code,
            pg.label,
            pg.description,
            pg.permissions,
            pg.is_system     AS "isSystemRole"
       FROM cip_platform.role_groups rg
       JOIN cip_platform.permission_groups pg ON pg.id = rg.group_id
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
  // Slice 68: cross-schema join — user_role_assignments → users (email, fullName).
  const r = await client.query<EmployeeSummary>(
    `SELECT u.id,
            u.tenant_id AS "tenantId",
            u.email,
            u.full_name AS "fullName"
       FROM cip_platform.user_role_assignments ura
       JOIN cip_platform.users u ON u.id = ura.user_id
      WHERE ura.role_id = $1
      ORDER BY u.email`,
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
            tenant_id  AS "tenantId",
            service, module, code, label, description,
            permissions,
            is_system  AS "isSystemRole"
       FROM cip_platform.permission_groups
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
            tenant_id  AS "tenantId",
            service, module, code, label, description,
            permissions,
            is_system  AS "isSystemRole"
       FROM cip_platform.permission_groups
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
       FROM cip_platform.role_groups rg
       JOIN cip_platform.roles r ON r.id = rg.role_id
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
 * Slice 68: list users holding a specific permission. Matches literals
 * AND globs that COVER the queried permission. Identity (email, fullName)
 * comes from cip_platform.users (cross-schema join).
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
    `SELECT DISTINCT u.id,
            u.tenant_id AS "tenantId",
            u.email,
            u.full_name AS "fullName"
       FROM cip_platform.users u
       JOIN cip_platform.user_role_assignments ura ON ura.user_id  = u.id
       JOIN cip_platform.role_groups rg            ON rg.role_id   = ura.role_id
       JOIN cip_platform.permission_groups pg      ON pg.id        = rg.group_id
       JOIN jsonb_array_elements_text(pg.permissions) AS p ON true
      WHERE u.tenant_id = $1
        AND (p = $2 OR p = $3 OR p = '*')
      ORDER BY u.email`,
    [tenantId, permission, prefix],
  );
  return r.rows;
}
