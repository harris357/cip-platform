import type { PoolClient } from 'pg';
import {
  EmployeeSchema,
  type Employee,
  type EmployeeUpsert,
} from '../../types/employee.js';

// Slice 65: identity columns dropped from cip_hr.employees. For identity
// fields (email, fullName, etc.), use findEmployeeWithUser from
// employee-with-user.ts. For provider subjects (keycloak_id, aad_oid), use
// getKeycloakSubject / getAadOid from identity-links.ts.

const EMPLOYEE_COLUMNS = `
  id,
  tenant_id       AS "tenantId",
  user_id         AS "userId",
  phone,
  employment_type AS "employmentType",
  created_at      AS "createdAt",
  updated_at      AS "updatedAt"
`;

function rowToEmployee(row: unknown): Employee {
  const r = row as Record<string, unknown>;
  return EmployeeSchema.parse({
    id:             r['id'],
    tenantId:       r['tenantId'],
    userId:         r['userId'],
    phone:          r['phone'] ?? null,
    employmentType: r['employmentType'],
    createdAt:      (r['createdAt'] as Date | string).toString(),
    updatedAt:      (r['updatedAt'] as Date | string).toString(),
  });
}

// All functions take PoolClient (not Pool) — caller manages the withTenantRLS / set_config wrapper.
// employees has RLS enabled (per Slice 05A); callers must set `app.current_tenant_id` first.

export async function findEmployeeById(
  client: PoolClient,
  tenantId: string,
  id: string,
): Promise<Employee | null> {
  const r = await client.query(
    `SELECT ${EMPLOYEE_COLUMNS} FROM employees
     WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
    [tenantId, id],
  );
  return r.rows[0] ? rowToEmployee(r.rows[0]) : null;
}

export async function findEmployeeByUserId(
  client: PoolClient,
  tenantId: string,
  userId: string,
): Promise<Employee | null> {
  const r = await client.query(
    `SELECT ${EMPLOYEE_COLUMNS} FROM employees
     WHERE tenant_id = $1 AND user_id = $2 LIMIT 1`,
    [tenantId, userId],
  );
  return r.rows[0] ? rowToEmployee(r.rows[0]) : null;
}

// Slice 65: keycloak subject moved to cip_platform.user_identity_links.
// This helper resolves the user via the link, then finds the employee.
export async function findEmployeeByKeycloakId(
  client: PoolClient,
  tenantId: string,
  keycloakSub: string,
): Promise<Employee | null> {
  const r = await client.query(
    `SELECT ${EMPLOYEE_COLUMNS}
       FROM cip_platform.user_identity_links uil
       JOIN employees e ON e.user_id = uil.user_id
      WHERE uil.tenant_id = $1
        AND uil.provider  = 'keycloak'
        AND uil.subject   = $2
      LIMIT 1`,
    [tenantId, keycloakSub],
  );
  return r.rows[0] ? rowToEmployee(r.rows[0]) : null;
}

// Slice 65: email lives on cip_platform.users. This helper joins on user_id.
export async function findEmployeeByEmail(
  client: PoolClient,
  tenantId: string,
  email: string,
): Promise<Employee | null> {
  const r = await client.query(
    `SELECT ${EMPLOYEE_COLUMNS}
       FROM cip_platform.users u
       JOIN employees e ON e.user_id = u.id
      WHERE u.tenant_id = $1 AND u.email = $2
      LIMIT 1`,
    [tenantId, email],
  );
  return r.rows[0] ? rowToEmployee(r.rows[0]) : null;
}

export async function upsertEmployee(
  client: PoolClient,
  input: EmployeeUpsert,
): Promise<Employee> {
  const r = await client.query(
    `INSERT INTO employees
       (id, tenant_id, user_id, phone, employment_type)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id) DO UPDATE SET
       phone           = EXCLUDED.phone,
       employment_type = EXCLUDED.employment_type,
       updated_at      = NOW()
     RETURNING ${EMPLOYEE_COLUMNS}`,
    [
      input.id,
      input.tenantId,
      input.userId,
      input.phone ?? null,
      input.employmentType,
    ],
  );
  return rowToEmployee(r.rows[0]);
}
