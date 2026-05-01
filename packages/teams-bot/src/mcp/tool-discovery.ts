import type { Tool as McpTool } from '@modelcontextprotocol/sdk/types.js';
import { getMcpClient } from './client.js';
import { fetchTopKTools } from '../intent/embed-cache.js';
import type { BotAuthContext } from '../auth/resolve-context.js';

interface CacheEntry {
  tools: McpTool[];
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const TTL = 5 * 60 * 1000;

// Per-(tenant, employee). Same-tenant users with different permissions
// get distinct cache entries.
function cacheKey(ctx: BotAuthContext): string {
  return `${ctx.tenantId}:${ctx.employeeId}`;
}

/**
 * Apply each tool's `requiredPermission` annotation against the caller's
 * permissions. Annotation conventions (declared at server.tool() time
 * in hr-service):
 *
 *   `null` (or absent) — no gate, every authenticated user sees the tool.
 *   `'<code>'`         — caller must have that permission code.
 *
 * Server-side handlers retain their own assertPermission / role checks
 * as defense in depth; this filter is the UX layer that hides tools the
 * user can't invoke from the LLM's catalog.
 */
function isToolPermitted(tool: McpTool, permissions: Record<string, boolean>): boolean {
  const required = (tool.annotations as Record<string, unknown> | undefined)?.['requiredPermission'];
  if (required === undefined || required === null || required === '') return true;
  if (typeof required !== 'string') return true;
  return permissions[required] === true;
}

/**
 * Returns the candidate tool catalog for the router LLM.
 *
 * Two filters applied in order:
 *   1. Permission filter — drops tools the user can't invoke. Driven by
 *      the `requiredPermission` annotation on each tool's MCP registration
 *      (no parallel registry on the bot side). Cached per (tenant,
 *      employee) for 5 min.
 *   2. Slice 44 vector retrieval — when `message` is provided, narrow the
 *      permitted set to tools whose embeddings are most similar to the
 *      message (top K via hr-service /admin/tool-retrieval). Bypassed if
 *      the retrieval call fails or returns nothing.
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
    const filtered = result.tools.filter(t => isToolPermitted(t, ctx.permissions));
    permitted = { tools: filtered, expiresAt: Date.now() + TTL };
    cache.set(key, permitted);
  }

  if (message && permitted.tools.length >= 10) {
    const topK = await fetchTopKTools(ctx, message);
    if (topK && topK.length > 0) {
      const intersection = permitted.tools.filter(t => topK.includes(t.name));
      if (intersection.length > 0) {
        return intersection;
      }
    }
  }

  return permitted.tools;
}
