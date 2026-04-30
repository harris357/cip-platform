import type { PoolClient } from 'pg';

export interface RoutingRule {
  service: string;
  purpose: string;
  alias:   string;
  notes:   string | null;
}

/**
 * Slice 39A: list every routing rule for a given service. Used by the
 * /admin/routing-rules?service=X endpoint AND by hr-service's own
 * in-process resolver to build a per-service map.
 */
export async function listRoutingRulesByService(
  client: PoolClient,
  service: string,
): Promise<RoutingRule[]> {
  const r = await client.query<RoutingRule>(
    `SELECT service, purpose, alias, notes
       FROM routing_rules
      WHERE service = $1
      ORDER BY purpose`,
    [service],
  );
  return r.rows;
}

/**
 * Slice 39A: read tenant_settings.routing_overrides for a tenant.
 * Returns the JSONB blob as a Record<string, string>; '<service>.<purpose>' → alias.
 */
export async function getTenantRoutingOverrides(
  client: PoolClient,
  tenantId: string,
): Promise<Record<string, string>> {
  const r = await client.query<{ overrides: Record<string, string> }>(
    `SELECT COALESCE(routing_overrides, '{}'::jsonb) AS overrides
       FROM tenant_settings WHERE tenant_id = $1`,
    [tenantId],
  );
  return r.rows[0]?.overrides ?? {};
}
