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
       FROM cip_platform.routing_rules
      WHERE service = $1
      ORDER BY purpose`,
    [service],
  );
  return r.rows;
}

/**
 * Slice 44: fetch a single routing rule's alias by (service, purpose).
 * Used by hr-service's own retrieval endpoint to resolve `bot.embed`
 * → `mistral-embed` (or whatever the operator overrode it to).
 * Returns null if no rule registered.
 */
export async function getRoutingRule(
  client: PoolClient,
  service: string,
  purpose: string,
): Promise<string | null> {
  const r = await client.query<{ alias: string }>(
    `SELECT alias FROM cip_platform.routing_rules WHERE service = $1 AND purpose = $2`,
    [service, purpose],
  );
  return r.rows[0]?.alias ?? null;
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
       FROM cip_platform.tenant_settings WHERE tenant_id = $1`,
    [tenantId],
  );
  return r.rows[0]?.overrides ?? {};
}
