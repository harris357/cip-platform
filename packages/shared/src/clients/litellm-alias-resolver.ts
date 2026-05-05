// Slice 58E — consolidated alias resolver. Lives in @cip/shared so
// every consumer (hr-service activities, teams-bot LangGraph nodes,
// future doc-service strategies) shares one implementation.
//
// Pre-58E there were two near-identical copies (hr-service DB-direct,
// teams-bot HTTP). Cross-DB constraints made the HTTP path the only
// universally usable one — hr-service activities now self-call hr-
// service's `/admin/routing-rules` endpoint over HTTP for ~one round
// trip per pod per (tenant, service) per 5-minute window. Net cost is
// negligible; implementation drift goes away.
//
// Resolution order (preserved verbatim from pre-58E):
//   1. tenant override on (service, purpose)
//   2. global routing_rule for (service, purpose)
//   3. FALLBACK_ALIAS ('cip-chat')
//
// Cache: 5-minute TTL keyed on tenantId. Per-tenant cache is the
// outer layer; per-service rules are filtered from a single
// upstream response. Test helper `_resetAliasResolverCache()` is
// exposed for the moved test set.
//
// The hr-service `GET /admin/routing-rules?service=<svc>&tenantId=<tid>`
// response shape is documented in
// hr-service/src/routes/admin/routing-rules.ts; we re-decode that
// shape here.

const FALLBACK_ALIAS = 'cip-chat';
const TTL_MS = 5 * 60 * 1000;

interface RuleSet {
  /** purpose → alias for the queried service. */
  rules:     Record<string, string>;
  /** 'service.purpose' → alias for any service the tenant overrode. */
  overrides: Record<string, string>;
  expiresAt: number;
}

// Cache key: `${tenantId}::${service}` — distinct services see distinct
// rule maps even when sharing a tenant. The per-tenant overrides field
// is identical across services, so we accept the small duplication for
// a simpler key shape.
const cache = new Map<string, RuleSet>();

function cacheKey(tenantId: string, service: string): string {
  return `${tenantId}::${service}`;
}

async function loadRules(service: string, tenantId: string): Promise<RuleSet> {
  const key = cacheKey(tenantId, service);
  const cached = cache.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached;

  const baseUrl = process.env['HR_SERVICE_URL'];
  const token   = process.env['PLATFORM_ADMIN_TOKEN'];
  if (!baseUrl || !token) {
    console.warn('[alias-resolver] HR_SERVICE_URL or PLATFORM_ADMIN_TOKEN missing — falling back');
    const empty: RuleSet = { rules: {}, overrides: {}, expiresAt: Date.now() + TTL_MS };
    cache.set(key, empty);
    return empty;
  }
  const url = new URL(`${baseUrl}/admin/routing-rules`);
  url.searchParams.set('service',  service);
  url.searchParams.set('tenantId', tenantId);

  let resp: Response;
  try {
    resp = await fetch(url.toString(), {
      headers: { 'x-platform-admin-token': token },
    });
  } catch (err) {
    console.warn(`[alias-resolver] fetch threw: ${err instanceof Error ? err.message : String(err)} — falling back`);
    const fb: RuleSet = { rules: {}, overrides: {}, expiresAt: Date.now() + TTL_MS };
    cache.set(key, fb);
    return fb;
  }
  if (!resp.ok) {
    console.warn(`[alias-resolver] fetch failed: HTTP ${resp.status} — falling back`);
    const fb: RuleSet = { rules: {}, overrides: {}, expiresAt: Date.now() + TTL_MS };
    cache.set(key, fb);
    return fb;
  }
  const body = (await resp.json()) as {
    rules:     Array<{ purpose: string; alias: string }>;
    overrides: Record<string, string>;
  };
  const rules = Object.fromEntries(body.rules.map(r => [r.purpose, r.alias]));
  const entry: RuleSet = {
    rules,
    overrides: body.overrides,
    expiresAt: Date.now() + TTL_MS,
  };
  cache.set(key, entry);
  return entry;
}

/**
 * Resolve a `(service, purpose)` to a LiteLLM alias for a given tenant.
 * Order: tenant override → global routing_rule → FALLBACK_ALIAS.
 */
export async function resolveAlias(args: {
  service:  string;
  purpose:  string;
  tenantId: string;
}): Promise<string> {
  const ruleset = await loadRules(args.service, args.tenantId);
  const overrideKey = `${args.service}.${args.purpose}`;
  if (ruleset.overrides[overrideKey]) return ruleset.overrides[overrideKey]!;
  if (ruleset.rules[args.purpose])    return ruleset.rules[args.purpose]!;
  console.warn(`[alias-resolver] no rule for ${overrideKey} — falling back to ${FALLBACK_ALIAS}`);
  return FALLBACK_ALIAS;
}

/** Test-only — drop the cache between cases. */
export function _resetAliasResolverCache(): void {
  cache.clear();
}
