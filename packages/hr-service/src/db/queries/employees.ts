import type { PoolClient } from 'pg';
import {
  EmployeeSchema,
  type Employee,
  type EmployeeUpsert,
} from '../../types/employee.js';

const EMPLOYEE_COLUMNS = `
  id,
  tenant_id       AS "tenantId",
  email,
  full_name       AS "fullName",
  given_name      AS "givenName",
  surname,
  phone,
  aad_oid         AS "aadOid",
  keycloak_id     AS "keycloakId",
  identity_type   AS "identityType",
  employment_type AS "employmentType",
  created_at      AS "createdAt",
  updated_at      AS "updatedAt"
`;

function rowToEmployee(row: unknown): Employee {
  const r = row as Record<string, unknown>;
  return EmployeeSchema.parse({
    id:             r['id'],
    tenantId:       r['tenantId'],
    email:          r['email'],
    fullName:       r['fullName'],
    givenName:      r['givenName'] ?? null,
    surname:        r['surname'] ?? null,
    phone:          r['phone'] ?? null,
    aadOid:         r['aadOid'] ?? null,
    keycloakId:     r['keycloakId'] ?? null,
    identityType:   r['identityType'],
    employmentType: r['employmentType'],
    createdAt:      (r['createdAt'] as Date | string).toString(),
    updatedAt:      (r['updatedAt'] as Date | string).toString(),
  });
}

// All functions take PoolClient (not Pool) — caller manages the withTenantRLS / set_config wrapper.
// employees has RLS enabled (per Slice 05A); callers must set `app.current_tenant_id` first.

export async function findEmployeeByEmail(
  client: PoolClient,
  tenantId: string,
  email: string,
): Promise<Employee | null> {
  const r = await client.query(
    `SELECT ${EMPLOYEE_COLUMNS} FROM employees
     WHERE tenant_id = $1 AND email = $2 LIMIT 1`,
    [tenantId, email],
  );
  return r.rows[0] ? rowToEmployee(r.rows[0]) : null;
}

export async function findEmployeeByKeycloakId(
  client: PoolClient,
  tenantId: string,
  keycloakId: string,
): Promise<Employee | null> {
  const r = await client.query(
    `SELECT ${EMPLOYEE_COLUMNS} FROM employees
     WHERE tenant_id = $1 AND keycloak_id = $2 LIMIT 1`,
    [tenantId, keycloakId],
  );
  return r.rows[0] ? rowToEmployee(r.rows[0]) : null;
}

export async function upsertEmployee(
  client: PoolClient,
  input: EmployeeUpsert,
): Promise<Employee> {
  const r = await client.query(
    `INSERT INTO employees
       (id, tenant_id, email, full_name, given_name, surname, phone,
        aad_oid, keycloak_id, identity_type, employment_type)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (tenant_id, email) DO UPDATE SET
       full_name       = EXCLUDED.full_name,
       given_name      = EXCLUDED.given_name,
       surname         = EXCLUDED.surname,
       phone           = EXCLUDED.phone,
       aad_oid         = EXCLUDED.aad_oid,
       keycloak_id     = EXCLUDED.keycloak_id,
       identity_type   = EXCLUDED.identity_type,
       employment_type = EXCLUDED.employment_type,
       updated_at      = NOW()
     RETURNING ${EMPLOYEE_COLUMNS}`,
    [
      input.id,
      input.tenantId,
      input.email,
      input.fullName,
      input.givenName ?? null,
      input.surname   ?? null,
      input.phone     ?? null,
      input.aadOid    ?? null,
      input.keycloakId ?? null,
      input.identityType,
      input.employmentType,
    ],
  );
  return rowToEmployee(r.rows[0]);
}
