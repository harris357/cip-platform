import type { PoolClient } from 'pg';

/**
 * Slice 38: return the deduped, sorted list of permission codes the
 * given employee holds — joining employee_roles → roles → flattening
 * the JSONB array on roles.permissions.
 *
 * Caller is responsible for setting the tenant RLS GUC; this function
 * just runs the JOIN.
 */
export async function getPermissionsForEmployee(
  client: PoolClient,
  employeeId: string,
): Promise<string[]> {
  const r = await client.query<{ p: string }>(
    `SELECT DISTINCT jsonb_array_elements_text(r.permissions) AS p
     FROM employee_roles er
     JOIN roles r ON r.id = er.role_id
     WHERE er.employee_id = $1`,
    [employeeId],
  );
  return r.rows.map(row => row.p).sort();
}

/**
 * Slice 38: return the role codes attached to the given employee.
 * Used by get_employee_permissions for UI display + parity with the
 * Slice 32 realm-role check.
 */
export async function getRoleCodesForEmployee(
  client: PoolClient,
  employeeId: string,
): Promise<string[]> {
  const r = await client.query<{ code: string }>(
    `SELECT r.code
     FROM employee_roles er
     JOIN roles r ON r.id = er.role_id
     WHERE er.employee_id = $1
     ORDER BY r.code`,
    [employeeId],
  );
  return r.rows.map(row => row.code);
}

/**
 * Slice 38: idempotently grant a role (by its code) to an employee.
 * Roles are tenant-scoped — the lookup is constrained to the caller's tenant.
 */
export async function grantRoleByCode(
  client: PoolClient,
  tenantId: string,
  employeeId: string,
  roleCode: string,
  grantedBy: string | null,
): Promise<void> {
  await client.query(
    `INSERT INTO employee_roles (employee_id, role_id, granted_by)
     SELECT $1, id, $4 FROM roles WHERE tenant_id = $2 AND code = $3
     ON CONFLICT DO NOTHING`,
    [employeeId, tenantId, roleCode, grantedBy],
  );
}

/**
 * Slice 38: revoke a role (by code) from an employee. Idempotent — silently
 * no-ops if the row didn't exist.
 */
export async function revokeRoleByCode(
  client: PoolClient,
  tenantId: string,
  employeeId: string,
  roleCode: string,
): Promise<void> {
  await client.query(
    `DELETE FROM employee_roles
     WHERE employee_id = $1
       AND role_id IN (
         SELECT id FROM roles WHERE tenant_id = $2 AND code = $3
       )`,
    [employeeId, tenantId, roleCode],
  );
}

/**
 * Slice 38: count distinct role codes assigned to an employee.
 * Used by employee.revoke_permission to refuse leaving a user role-less.
 */
export async function countRolesForEmployee(
  client: PoolClient,
  employeeId: string,
): Promise<number> {
  const r = await client.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM employee_roles WHERE employee_id = $1`,
    [employeeId],
  );
  return parseInt(r.rows[0]?.n ?? '0', 10);
}
