import { createPool, withTenantRLS } from '@cip/shared/src/clients/postgres.js';

// Slice 38 + 42A — system permission groups for newly provisioned tenants.
// Slice 42A renamed `roles` → `permission_groups` and added explicit
// `service` + `module` columns. These five system definitions all span
// multiple modules (employee + cert + compliance) and so use the
// transitional `module = 'general'` marker. Slice 42C will split them
// into per-module groups + a composing role.
//
// Each entry pairs:
//   - `code`: stable identifier, unique within tenant per (service, module, code)
//   - `keycloak_role`: which realm role this implies (`hr` or `employee`)
//   - `permissions`: fine-grained codes from the catalog. Slice 42A's
//     resolver expands glob entries (cert.*, *) at lookup time.
const SYSTEM_GROUPS = [
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
      for (const group of SYSTEM_GROUPS) {
        // service='hr-service', module='general' (transitional). Slice 42C
        // splits each into per-module groups + a composing role.
        await c.query(
          `INSERT INTO permission_groups
             (tenant_id, service, module, code, keycloak_role, label, permissions, is_system_role)
           VALUES ($1, 'hr-service', 'general', $2, $3, $4, $5::jsonb, true)
           ON CONFLICT (tenant_id, service, module, code) DO UPDATE
             SET permissions   = EXCLUDED.permissions,
                 label         = EXCLUDED.label,
                 keycloak_role = EXCLUDED.keycloak_role`,
          [
            input.tenantId,
            group.code,
            group.keycloak_role,
            group.label,
            JSON.stringify(group.permissions),
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
