import { getPool } from '../db/index.js'
import {
  listRoutingRulesByService,
  getTenantRoutingOverrides,
  type RoutingRule,
} from '../db/queries/routing-rules.js'

const FALLBACK_ALIAS = 'cip-chat'
const TTL_MS = 5 * 60 * 1000

interface CacheEntry { rules: Map<string, string>; expiresAt: number }
interface OverrideEntry { overrides: Record<string, string>; expiresAt: number }

const rulesCache: Map<string, CacheEntry> = new Map()
const overridesCache: Map<string, OverrideEntry> = new Map()

async function loadServiceRules(service: string): Promise<Map<string, string>> {
  const cached = rulesCache.get(service)
  if (cached && Date.now() < cached.expiresAt) return cached.rules

  const pool = getPool()
  const client = await pool.connect()
  try {
    const rows: RoutingRule[] = await listRoutingRulesByService(client, service)
    const rules = new Map(rows.map(r => [r.purpose, r.alias]))
    rulesCache.set(service, { rules, expiresAt: Date.now() + TTL_MS })
    return rules
  } finally {
    client.release()
  }
}

async function loadTenantOverrides(tenantId: string): Promise<Record<string, string>> {
  const cached = overridesCache.get(tenantId)
  if (cached && Date.now() < cached.expiresAt) return cached.overrides

  const pool = getPool()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantId])
    const overrides = await getTenantRoutingOverrides(client, tenantId)
    await client.query('COMMIT')
    overridesCache.set(tenantId, { overrides, expiresAt: Date.now() + TTL_MS })
    return overrides
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw err
  } finally {
    client.release()
  }
}

/**
 * Slice 39A: resolve a `(service, purpose)` to a LiteLLM alias for a given tenant.
 * Order: tenant override → global routing_rule → FALLBACK_ALIAS.
 */
export async function resolveAlias(args: {
  service:  string
  purpose:  string
  tenantId: string
}): Promise<string> {
  const overrides = await loadTenantOverrides(args.tenantId)
  const overrideKey = `${args.service}.${args.purpose}`
  if (overrides[overrideKey]) return overrides[overrideKey]!

  const rules = await loadServiceRules(args.service)
  const alias = rules.get(args.purpose)
  if (alias) return alias

  console.warn(`[alias-resolver] no rule for ${overrideKey} — falling back to ${FALLBACK_ALIAS}`)
  return FALLBACK_ALIAS
}

// Test-only helper to clear caches between cases.
export function _resetAliasResolverCaches(): void {
  rulesCache.clear()
  overridesCache.clear()
}
