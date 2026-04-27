import { createPool, withTenantRLS } from '@cip/shared/src/clients/postgres.js';

const SYSTEM_ROLES = [
  {
    keycloak_role: 'hr_admin',
    label: 'HR Administrator',
    capabilities: {
      uploadCertForOthers: true,
      viewTeamCerts: true,
      resolveHitl: true,
      uploadCertForSelf: true,
      viewOwnCerts: true,
      viewAllCerts: true,
      viewCostReports: true,
      allocateEmployees: true,
    },
  },
  {
    keycloak_role: 'field_operations',
    label: 'Field Operations',
    capabilities: { uploadCertForOthers: true, viewTeamCerts: true, resolveHitl: true },
  },
  {
    keycloak_role: 'field_employee',
    label: 'Field Employee',
    capabilities: { uploadCertForSelf: true, viewOwnCerts: true },
  },
  {
    keycloak_role: 'compliance_manager',
    label: 'Compliance Manager',
    capabilities: { viewAllCerts: true, viewCostReports: true },
  },
  {
    keycloak_role: 'site_manager',
    label: 'Site Manager',
    capabilities: { viewTeamCerts: true, allocateEmployees: true },
  },
] as const;

export async function initTenantDatabase(input: { tenantId: string }): Promise<void> {
  const pool = createPool(process.env['DATABASE_URL_PLATFORM'] ?? '');
  const client = await pool.connect();
  try {
    await withTenantRLS(client, input.tenantId, async (c) => {
      for (const role of SYSTEM_ROLES) {
        await c.query(
          `INSERT INTO roles (tenant_id, keycloak_role, label, capabilities, is_system_role)
           VALUES ($1, $2, $3, $4::jsonb, true)
           ON CONFLICT (tenant_id, keycloak_role) DO NOTHING`,
          [input.tenantId, role.keycloak_role, role.label, JSON.stringify(role.capabilities)],
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
