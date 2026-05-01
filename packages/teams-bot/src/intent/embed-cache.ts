// Slice 44: bot-side cache for hr-service's /admin/tool-retrieval responses.
//
// The bot doesn't embed messages itself — embedding + pgvector lookup live
// in hr-service (which has DB access). The bot calls /admin/tool-retrieval
// with the user's message text and gets back a top-K list of tool names.
//
// This cache memoises that response keyed by sha256(text), so retries,
// "did it work?" follow-ups, and SSO replays don't re-fetch identical
// retrieval results. 256 entries × 60s TTL is enough for chat workloads.

import { createHash } from 'node:crypto';
import type { BotAuthContext } from '../auth/resolve-context.js';

const TTL_MS = 60 * 1000;
const MAX_ENTRIES = 256;
const DEFAULT_K = 15;

interface Entry {
  tools: string[];
  expiresAt: number;
}

const cache = new Map<string, Entry>();

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function lruEvict(): void {
  if (cache.size <= MAX_ENTRIES) return;
  const oldestKey = cache.keys().next().value;
  if (oldestKey) cache.delete(oldestKey);
}

/**
 * Fetch the top-K tool names for a given user message via hr-service's
 * /admin/tool-retrieval. Returns null on any failure — caller is expected
 * to fall back to the full permission-filtered list (graceful degradation).
 */
export async function fetchTopKTools(
  ctx: BotAuthContext,
  text: string,
  k: number = DEFAULT_K,
): Promise<string[] | null> {
  if (!text.trim()) return null;

  // Cache key includes tenant + employee so retrieval results aren't shared
  // across users (top-K is the same for everyone today, but if we ever add
  // per-tenant tool overrides, the cache won't have to be invalidated).
  const key = `${ctx.tenantId}:${ctx.employeeId}:${k}:${hashText(text)}`;
  const cached = cache.get(key);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.tools;
  }

  const baseUrl = process.env['HR_SERVICE_URL'];
  const token = process.env['PLATFORM_ADMIN_TOKEN'];
  if (!baseUrl || !token) {
    console.warn('[tool-retrieval] HR_SERVICE_URL or PLATFORM_ADMIN_TOKEN missing — falling back');
    return null;
  }

  try {
    const resp = await fetch(`${baseUrl}/admin/tool-retrieval`, {
      method:  'POST',
      headers: {
        'content-type': 'application/json',
        'x-platform-admin-token': token,
      },
      body: JSON.stringify({ text, k, tenantId: ctx.tenantId }),
    });
    if (!resp.ok) {
      console.warn(`[tool-retrieval] HTTP ${resp.status} — falling back`);
      return null;
    }
    const body = (await resp.json()) as { tools?: string[] };
    const tools = body.tools ?? [];

    cache.set(key, { tools, expiresAt: Date.now() + TTL_MS });
    lruEvict();
    return tools;
  } catch (err) {
    console.warn(
      `[tool-retrieval] fetch threw: ${err instanceof Error ? err.message : String(err)} — falling back`,
    );
    return null;
  }
}
