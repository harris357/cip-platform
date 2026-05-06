import type { PoolClient } from 'pg';

// Slice 66: read tenant_settings.auto_onboard_employees from cip_platform.
// Cross-schema SELECT — same Postgres instance as DATABASE_URL_HR.

export interface TenantSettings {
  autoOnboardEmployees: boolean;
}

export async function getTenantSettings(
  client: PoolClient,
  tenantId: string,
): Promise<TenantSettings> {
  const r = await client.query<{ auto_onboard_employees: boolean }>(
    `SELECT auto_onboard_employees
       FROM cip_platform.tenant_settings
      WHERE tenant_id = $1
      LIMIT 1`,
    [tenantId],
  );
  return {
    autoOnboardEmployees: r.rows[0]?.auto_onboard_employees ?? true,
  };
}

export async function getTenantAutoOnboard(
  client: PoolClient,
  tenantId: string,
): Promise<boolean> {
  const settings = await getTenantSettings(client, tenantId);
  return settings.autoOnboardEmployees;
}
