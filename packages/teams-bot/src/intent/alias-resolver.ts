// Slice 39A: bot-side LiteLLM alias resolver. Calls hr-service's
// /admin/routing-rules endpoint to fetch the global rules + per-tenant
// overrides, caches per-tenant for 5 minutes (matches tool-discovery.ts
// and tenant-resolver.ts patterns).

const FALLBACK_ALIAS = 'cip-chat';
const TTL_MS = 5 * 60 * 1000;

interface RuleSet {
  rules:     Record<string, string>; // purpose → alias
  overrides: Record<string, string>; // 'service.purpose' → alias
  expiresAt: number;
}

const cache = new Map<string, RuleSet>(); // key: tenantId

async function loadRules(tenantId: string): Promise<RuleSet> {
  const cached = cache.get(tenantId);
  if (cached && Date.now() < cached.expiresAt) return cached;

  const baseUrl = process.env['HR_SERVICE_URL'];
  const token = process.env['PLATFORM_ADMIN_TOKEN'];
  if (!baseUrl || !token) {
    console.warn('[alias-resolver] HR_SERVICE_URL or PLATFORM_ADMIN_TOKEN missing — falling back');
    return { rules: {}, overrides: {}, expiresAt: Date.now() + TTL_MS };
  }
  const url = new URL(`${baseUrl}/admin/routing-rules`);
  url.searchParams.set('service', 'bot');
  url.searchParams.set('tenantId', tenantId);

  let resp: Response;
  try {
    resp = await fetch(url.toString(), {
      headers: { 'x-platform-admin-token': token },
    });
  } catch (err) {
    console.warn(`[alias-resolver] fetch threw: ${err instanceof Error ? err.message : String(err)} — falling back`);
    return { rules: {}, overrides: {}, expiresAt: Date.now() + TTL_MS };
  }
  if (!resp.ok) {
    console.warn(`[alias-resolver] fetch failed: HTTP ${resp.status} — falling back`);
    return { rules: {}, overrides: {}, expiresAt: Date.now() + TTL_MS };
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
  cache.set(tenantId, entry);
  return entry;
}

/**
 * Slice 39A: resolve `(bot, purpose)` to a LiteLLM alias for a given tenant.
 * Order: tenant override → global routing_rule → FALLBACK_ALIAS.
 *
 * The bot is always `service='bot'` — hardcoded here because the bot only
 * ever asks about its own routing.
 */
export async function resolveAlias(args: {
  purpose:  string;
  tenantId: string;
}): Promise<string> {
  const ruleset = await loadRules(args.tenantId);
  const overrideKey = `bot.${args.purpose}`;
  if (ruleset.overrides[overrideKey]) return ruleset.overrides[overrideKey]!;
  if (ruleset.rules[args.purpose]) return ruleset.rules[args.purpose]!;
  console.warn(`[alias-resolver] no rule for ${overrideKey} — falling back to ${FALLBACK_ALIAS}`);
  return FALLBACK_ALIAS;
}

// Test-only helper to clear the cache between cases.
export function _resetAliasResolverCache(): void {
  cache.clear();
}
