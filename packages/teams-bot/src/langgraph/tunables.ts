// Slice 45: bot-side fetcher + cache + getter for hr-service's
// /admin/bot-tunables. Same shape as alias-resolver: 5-min per-tenant
// cache, fail-open to code defaults if the endpoint is unreachable.

const TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  tunables:  Record<string, unknown>;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/**
 * Fetch the merged tunables for a tenant. Returns an empty object on
 * any failure — call sites then fall back to code-resident defaults
 * via `getTunable<T>(tunables, key, fallback)`.
 */
export async function getTunables(tenantId: string): Promise<Record<string, unknown>> {
  const cached = cache.get(tenantId);
  if (cached && Date.now() < cached.expiresAt) return cached.tunables;

  const baseUrl = process.env['HR_SERVICE_URL'];
  const token = process.env['PLATFORM_ADMIN_TOKEN'];
  if (!baseUrl || !token) {
    console.warn('[tunables] HR_SERVICE_URL or PLATFORM_ADMIN_TOKEN missing — using defaults');
    return {};
  }

  try {
    const url = new URL(`${baseUrl}/admin/bot-tunables`);
    url.searchParams.set('tenantId', tenantId);
    const resp = await fetch(url.toString(), {
      headers: { 'x-platform-admin-token': token },
    });
    if (!resp.ok) {
      console.warn(`[tunables] HTTP ${resp.status} — using defaults`);
      return {};
    }
    const body = (await resp.json()) as { tunables: Record<string, unknown> };
    const entry: CacheEntry = {
      tunables: body.tunables,
      expiresAt: Date.now() + TTL_MS,
    };
    cache.set(tenantId, entry);
    return body.tunables;
  } catch (err) {
    console.warn(`[tunables] fetch threw: ${err instanceof Error ? err.message : String(err)} — using defaults`);
    return {};
  }
}

/**
 * Read a tunable with a code-resident fallback. Use this at every call
 * site — never index `tunables[key]` directly without a default.
 */
export function getTunable<T>(
  tunables: Record<string, unknown>,
  key:      string,
  fallback: T,
): T {
  const value = tunables[key];
  if (value === undefined || value === null) return fallback;
  return value as T;
}

// Test-only.
export function _resetTunablesCache(): void {
  cache.clear();
}
