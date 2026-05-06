// Slice 33 additions to the employees query layer (kept separate from the
// Slice 31 file to minimize merge surface). Slice 65: identity columns
// dropped — for identity reads use findEmployeeWithUser; for KC/AAD subjects
// use getKeycloakSubject / getAadOid from identity-links.ts.

import type { PoolClient } from 'pg';
import { EmployeeSchema, type Employee } from '../../types/employee.js';

const COLS = `
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

// Slice 65: identity_type now lives on cip_platform.users; aad_oid lives in
// cip_platform.user_identity_links. This function updates both. employees.id
// == users.id (1:1 mapping from slice 64).
export async function updateEmployeeIdentityType(
  client: PoolClient,
  tenantId: string,
  id: string,
  identityType: 'aad_federated' | 'field_employee' | 'local_password',
  aadOid: string | null,
  phone: string | null,
): Promise<void> {
  // 1. Update identityType on users
  await client.query(
    `UPDATE cip_platform.users
        SET identity_type = $3, updated_at = NOW()
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id, identityType],
  );

  // 2. Sync the AAD link in user_identity_links (insert/update or delete)
  if (aadOid) {
    await client.query(
      `INSERT INTO cip_platform.user_identity_links
         (user_id, tenant_id, provider, subject)
       VALUES ($2, $1, 'aad', $3)
       ON CONFLICT (user_id, provider) DO UPDATE
         SET subject = EXCLUDED.subject, updated_at = NOW()`,
      [tenantId, id, aadOid],
    );
  } else {
    await client.query(
      `DELETE FROM cip_platform.user_identity_links
        WHERE user_id = $1 AND provider = 'aad'`,
      [id],
    );
  }

  // 3. Update phone on employees (HR field stays here)
  await client.query(
    `UPDATE employees
        SET phone = $3, updated_at = NOW()
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id, phone],
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
