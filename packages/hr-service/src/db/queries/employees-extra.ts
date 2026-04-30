// Slice 33 additions to the employees query layer (kept separate from the
// Slice 31 file to minimize merge surface). Once merged, both can collapse
// into queries/employees.ts in a future cleanup slice.

import type { PoolClient } from 'pg';
import { EmployeeSchema, type Employee } from '../../types/employee.js';

const COLS = `
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

export async function findEmployeeById(
  client: PoolClient,
  tenantId: string,
  id: string,
): Promise<Employee | null> {
  const r = await client.query(
    `SELECT ${COLS} FROM employees WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
    [tenantId, id],
  );
  return r.rows[0] ? rowToEmployee(r.rows[0]) : null;
}

export async function updateEmployeeIdentityType(
  client: PoolClient,
  tenantId: string,
  id: string,
  identityType: 'aad_federated' | 'field_employee',
  aadOid: string | null,
  phone: string | null,
): Promise<void> {
  await client.query(
    `UPDATE employees
     SET identity_type = $3, aad_oid = $4, phone = $5, updated_at = NOW()
     WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id, identityType, aadOid, phone],
  );
}

export async function setEmployeeDisabledAt(
  client: PoolClient,
  tenantId: string,
  id: string,
  disabledAt: Date | null,
): Promise<void> {
  await client.query(
    `UPDATE employees
     SET disabled_at = $3, updated_at = NOW()
     WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id, disabledAt],
  );
}
