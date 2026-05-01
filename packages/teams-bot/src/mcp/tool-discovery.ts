import type { Tool as McpTool } from '@modelcontextprotocol/sdk/types.js';
import { getMcpClient } from './client.js';
import { isToolPermitted } from './tool-permissions.js';
import { fetchTopKTools } from '../intent/embed-cache.js';
import type { BotAuthContext } from '../auth/resolve-context.js';

interface CacheEntry {
  tools: McpTool[];
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const TTL = 5 * 60 * 1000;

// Slice 43: cache key includes employeeId. Previously the key was just
// tenantId — same-tenant users with different permissions could share a
// cached entry, leaking the first caller's filtered tool set to subsequent
// callers. Permissions are derived from the user's roles + groups, so the
// cache must be per-user.
function cacheKey(ctx: BotAuthContext): string {
  return `${ctx.tenantId}:${ctx.employeeId}`;
}

/**
 * Slice 43 + 44: returns the candidate tool catalog for the router LLM.
 *
 * Two filters applied in order:
 *   1. Permission filter — drops tools the user can't invoke (TOOL_PERMISSIONS
 *      map mirrors hr-service's in-handler assertPermission/role checks).
 *      Cached per (tenant, employee) for 5 min.
 *   2. Slice 44 vector retrieval — when `message` is provided, narrow the
 *      permitted set to tools whose embeddings are most similar to the
 *      message (top K via hr-service /admin/tool-retrieval). Bypassed if
 *      the retrieval call fails or returns nothing — the router falls
 *      back to the full permitted list (graceful degradation).
 *
 * Pass `message` for the proceed path. Pass undefined (or skip) for paths
 * that don't have a user message yet (e.g., file uploads, where we already
 * know which tool to call).
 */
export async function discoverTools(
  ctx:     BotAuthContext,
  message?: string,
): Promise<McpTool[]> {
  const key = cacheKey(ctx);
  let permitted = cache.get(key);
  if (!permitted || Date.now() >= permitted.expiresAt) {
    const client = await getMcpClient(ctx.bearerToken);
    const result = await client.listTools();
    const filtered = result.tools.filter(tool =>
      isToolPermitted(tool.name, ctx.permissions, ctx.roles ?? []),
    );
    permitted = { tools: filtered, expiresAt: Date.now() + TTL };
    cache.set(key, permitted);
  }

  // Slice 44: vector retrieval pre-filter. Only applied when we have a
  // user message AND the catalog is large enough to benefit. Below ~10
  // tools, retrieval adds latency without improving accuracy.
  if (message && permitted.tools.length >= 10) {
    const topK = await fetchTopKTools(ctx, message);
    if (topK && topK.length > 0) {
      const intersection = permitted.tools.filter(t => topK.includes(t.name));
      if (intersection.length > 0) {
        return intersection;
      }
      // Empty intersection (no permitted tool ranked in top K) — fall
      // through to the full permitted list. Router LLM still works,
      // just sees more candidates.
    }
  }

  return permitted.tools;
}
