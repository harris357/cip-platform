import { createPool, withTenantRLS } from '@cip/shared/src/clients/postgres.js';

// Slice 38 — system role catalog for newly provisioned tenants.
// Each role pairs:
//   - `code`: stable role identifier, unique within tenant (DB key)
//   - `keycloak_role`: realm role this maps to. Slice 32 only defines two
//     realm roles (`hr`, `employee`), so the coarse gate is binary.
//   - `permissions`: fine-grained capability set, dot-style codes from the
//     Slice 38 catalog (cert.*, employee.*, compliance.*).
//
// Roles that grant any HR-tier permission (employee management, cert.approve,
// cert.list_all, compliance.view) map to realm role `hr`. The pure
// self-service role (`field_employee`) maps to `employee`.
const SYSTEM_ROLES = [
  {
    code: 'hr_admin',
    keycloak_role: 'hr',
    label: 'HR Administrator',
    permissions: [
      'employee.create', 'employee.list', 'employee.find',
      'employee.assign_role', 'employee.revoke_role',
      'employee.migrate_identity', 'employee.disable',
      'employee.grant_permission', 'employee.revoke_permission',
      'cert.approve', 'cert.list_all', 'cert.submit', 'cert.view_own',
      'compliance.view',
    ],
  },
  {
    code: 'field_operations',
    keycloak_role: 'hr',
    label: 'Field Operations',
    permissions: [
      'employee.list', 'employee.find',
      'cert.approve', 'cert.list_all', 'cert.submit', 'cert.view_own',
    ],
  },
  {
    code: 'field_employee',
    keycloak_role: 'employee',
    label: 'Field Employee',
    permissions: ['cert.submit', 'cert.view_own', 'compliance.view_own'],
  },
  {
    code: 'compliance_manager',
    keycloak_role: 'hr',
    label: 'Compliance Manager',
    permissions: ['compliance.view', 'cert.list_all'],
  },
  {
    code: 'site_manager',
    keycloak_role: 'hr',
    label: 'Site Manager',
    permissions: ['employee.list', 'cert.list_all'],
  },
] as const;

export async function initTenantDatabase(input: { tenantId: string }): Promise<void> {
  const pool = createPool(process.env['DATABASE_URL_PLATFORM'] ?? '');
  const client = await pool.connect();
  try {
    await withTenantRLS(client, input.tenantId, async (c) => {
      for (const role of SYSTEM_ROLES) {
        await c.query(
          `INSERT INTO roles (tenant_id, code, keycloak_role, label, permissions, is_system_role)
           VALUES ($1, $2, $3, $4, $5::jsonb, true)
           ON CONFLICT (tenant_id, code) DO UPDATE
             SET permissions   = EXCLUDED.permissions,
                 label         = EXCLUDED.label,
                 keycloak_role = EXCLUDED.keycloak_role`,
          [
            input.tenantId,
            role.code,
            role.keycloak_role,
            role.label,
            JSON.stringify(role.permissions),
          ],
        );
      }

      await c.query(
        `INSERT INTO tenant_settings (tenant_id, channel_config)
         VALUES ($1, '{}')
         ON CONFLICT (tenant_id) DO NOTHING`,
        [input.tenantId],
      );

      await c.query(
        `INSERT INTO certificate_types (tenant_id, code, label)
         VALUES ($1, 'PLACEHOLDER', 'Configure Your Certificate Library')
         ON CONFLICT (tenant_id, code) DO NOTHING`,
        [input.tenantId],
      );
    });
  } finally {
    client.release();
    await pool.end();
  }
}
