import { createPool, withTenantRLS } from '@cip/shared/src/clients/postgres.js';

// Slice 38 + 42A + 42C — system role catalog for newly provisioned tenants.
//
// Each business "role" composes N module-scoped groups via role_groups.
// Groups use glob permissions where appropriate (Slice 42A's resolver
// expands cert.* → all cert permissions at lookup time, so new
// permissions added to the catalog are automatically inherited).
//
// `keycloak_role` lives on the role (Slice 42C); it implies which KC
// realm role the assignee should also have. Slice 42B's bootstrap flow
// ensures both layers are granted.
interface ModuleGroup {
  module:      'cert' | 'employee' | 'compliance' | 'tenant';
  code:        string;
  label:       string;
  permissions: string[];
}

interface SystemRoleDef {
  code:          string;
  label:         string;
  description:   string;
  keycloak_role: 'hr' | 'employee';
  groups:        ModuleGroup[];
}

const SYSTEM_ROLES: SystemRoleDef[] = [
  {
    code:          'hr_admin',
    label:         'HR Administrator',
    description:   'Full HR-tier access across employee + cert + compliance modules.',
    keycloak_role: 'hr',
    groups: [
      { module: 'employee',   code: 'hr_admin__employee',   label: 'HR Admin (employee module)',   permissions: ['employee.*'] },
      { module: 'cert',       code: 'hr_admin__cert',       label: 'HR Admin (cert module)',       permissions: ['cert.*'] },
      { module: 'compliance', code: 'hr_admin__compliance', label: 'HR Admin (compliance module)', permissions: ['compliance.*'] },
    ],
  },
  {
    code:          'field_operations',
    label:         'Field Operations',
    description:   'Manage cert submissions and approvals; read-only employee view.',
    keycloak_role: 'hr',
    groups: [
      { module: 'employee', code: 'field_operations__employee', label: 'Field Ops (employee read)', permissions: ['employee.list', 'employee.find'] },
      { module: 'cert',     code: 'field_operations__cert',     label: 'Field Ops (cert)',          permissions: ['cert.approve', 'cert.list_all', 'cert.submit', 'cert.view_own'] },
    ],
  },
  {
    code:          'field_employee',
    label:         'Field Employee',
    description:   'Self-service: submit own certs, view own status.',
    keycloak_role: 'employee',
    groups: [
      { module: 'cert',       code: 'field_employee__cert',       label: 'Field Employee (cert)',           permissions: ['cert.submit', 'cert.view_own'] },
      { module: 'compliance', code: 'field_employee__compliance', label: 'Field Employee (compliance own)', permissions: ['compliance.view_own'] },
    ],
  },
  {
    code:          'compliance_manager',
    label:         'Compliance Manager',
    description:   'Tenant-wide compliance reports + cert audit.',
    keycloak_role: 'hr',
    groups: [
      { module: 'compliance', code: 'compliance_manager__compliance', label: 'Compliance Manager (compliance)', permissions: ['compliance.view'] },
      { module: 'cert',       code: 'compliance_manager__cert',       label: 'Compliance Manager (cert read)',  permissions: ['cert.list_all'] },
    ],
  },
  {
    code:          'site_manager',
    label:         'Site Manager',
    description:   'Site-level employee + cert oversight.',
    keycloak_role: 'hr',
    groups: [
      { module: 'employee', code: 'site_manager__employee', label: 'Site Manager (employee read)', permissions: ['employee.list'] },
      { module: 'cert',     code: 'site_manager__cert',     label: 'Site Manager (cert read)',     permissions: ['cert.list_all'] },
    ],
  },
];

export async function initTenantDatabase(input: { tenantId: string }): Promise<void> {
  const pool = createPool(process.env['DATABASE_URL_PLATFORM'] ?? '');
  const client = await pool.connect();
  try {
    await withTenantRLS(client, input.tenantId, async (c) => {
      for (const role of SYSTEM_ROLES) {
        // 1. Insert the per-module groups.
        for (const g of role.groups) {
          await c.query(
            `INSERT INTO permission_groups
               (tenant_id, service, module, code, label, permissions, is_system_role)
             VALUES ($1, 'hr-service', $2, $3, $4, $5::jsonb, true)
             ON CONFLICT (tenant_id, service, module, code) DO UPDATE
               SET permissions = EXCLUDED.permissions,
                   label       = EXCLUDED.label`,
            [input.tenantId, g.module, g.code, g.label, JSON.stringify(g.permissions)],
          );
        }

        // 2. Insert the role.
        const roleResult = await c.query<{ id: string }>(
          `INSERT INTO roles (tenant_id, code, label, description, keycloak_role, is_system_role)
           VALUES ($1, $2, $3, $4, $5, true)
           ON CONFLICT (tenant_id, code) DO UPDATE
             SET label         = EXCLUDED.label,
                 description   = EXCLUDED.description,
                 keycloak_role = EXCLUDED.keycloak_role
           RETURNING id`,
          [input.tenantId, role.code, role.label, role.description, role.keycloak_role],
        );
        const roleId = roleResult.rows[0]!.id;

        // 3. Link the role to its constituent groups via role_groups.
        for (const g of role.groups) {
          await c.query(
            `INSERT INTO role_groups (role_id, group_id)
             SELECT $1, id FROM permission_groups
              WHERE tenant_id = $2 AND service = 'hr-service' AND module = $3 AND code = $4
             ON CONFLICT DO NOTHING`,
            [roleId, input.tenantId, g.module, g.code],
          );
        }
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
