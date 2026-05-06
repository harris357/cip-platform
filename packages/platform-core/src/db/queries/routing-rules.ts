import { eq, and } from 'drizzle-orm'
import type { Db } from '../index.js'
import { routingRules, tenantSettings } from '../schema.js'

// Slice 63: drizzle-based routing-rules queries against
// cip_platform.routing_rules + cip_platform.tenant_settings.
// Mirrors hr-service/src/db/queries/routing-rules.ts (which now does
// cross-schema reads instead).

export interface RoutingRule {
  service: string
  purpose: string
  alias:   string
  notes:   string | null
}

export async function listRoutingRulesByService(
  db: Db,
  service: string,
): Promise<RoutingRule[]> {
  const rows = await db
    .select({
      service: routingRules.service,
      purpose: routingRules.purpose,
      alias:   routingRules.alias,
      notes:   routingRules.notes,
    })
    .from(routingRules)
    .where(eq(routingRules.service, service))
    .orderBy(routingRules.purpose)
  return rows
}

export async function getRoutingRule(
  db: Db,
  service: string,
  purpose: string,
): Promise<string | null> {
  const rows = await db
    .select({ alias: routingRules.alias })
    .from(routingRules)
    .where(and(eq(routingRules.service, service), eq(routingRules.purpose, purpose)))
    .limit(1)
  return rows[0]?.alias ?? null
}

export async function getTenantRoutingOverrides(
  db: Db,
  tenantId: string,
): Promise<Record<string, string>> {
  const rows = await db
    .select({ overrides: tenantSettings.routingOverrides })
    .from(tenantSettings)
    .where(eq(tenantSettings.tenantId, tenantId))
    .limit(1)
  return (rows[0]?.overrides as Record<string, string> | undefined) ?? {}
}
