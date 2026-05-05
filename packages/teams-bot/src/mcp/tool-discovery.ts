import type { Tool as McpTool } from '@modelcontextprotocol/sdk/types.js';
import { getMcpClientFor, getServers, setToolRouting, type ServerName } from './multi-server-client.js';
import { fetchTopKTools } from '../intent/embed-cache.js';
import { getToolMetadata } from './tool-metadata.js';
import type { BotAuthContext } from '../auth/resolve-context.js';

interface CacheEntry {
  tools: McpTool[];
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const TTL = 5 * 60 * 1000;

// Per-(tenant, employee). Same-tenant users with different permissions
// get distinct cache entries. Slice 58B-2b: catalog now spans every
// MCP server in the registry, but the cache key is unchanged — caller
// permissions are what changes between users, not the server list.
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
 * Fetch the catalog from a single MCP server, enrich each tool's
 * annotations from hr-service's metadata side-channel, and tag each
 * tool with its source server name (in `_source` so callers can route).
 *
 * Failure of one server fails the whole discovery (we'd rather crash
 * loud than silently render a half-catalog with the doc-service tools
 * missing). The caller can wrap this in a circuit breaker later.
 */
async function listFromServer(
  server:       ServerName,
  bearerToken:  string,
  metadata:     Record<string, Record<string, unknown>>,
): Promise<McpTool[]> {
  const client = await getMcpClientFor(server, bearerToken);
  const result = await client.listTools();
  // Hotfix: the MCP SDK strips non-spec annotation fields on the wire.
  // Merge the side-channel metadata back in so isToolPermitted (and
  // downstream gateWriteAction + tool-reference rendering) see
  // sideEffectLevel / requiredPermission / whenToUse / whenNotToUse /
  // commonNextTools / outputSchema. Today only hr-service exposes the
  // /admin/tool-metadata side-channel; doc-service tools rely on the
  // annotations the SDK does pass through (the SDK preserves enough
  // for our gates — server-side defense in depth covers the rest).
  return result.tools.map(t => ({
    ...t,
    annotations: { ...(t.annotations ?? {}), ...(metadata[t.name] ?? {}) },
    // Non-spec field; carried for the bot's internal routing only.
    // Stripped before being passed to the LLM.
    _source: server,
  })) as unknown as McpTool[];
}

/**
 * Returns the candidate tool catalog for the router LLM.
 *
 * Slice 58B-2b: the catalog is the union of every MCP server in the
 * registry (today: hr-service + document-service). Tool names are
 * globally unique within this view — the merge step throws on
 * collision (hard rule #1).
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
    const metadata = await getToolMetadata();

    // Fan out across servers in parallel. listFromServer tags each tool
    // with `_source` so we can populate the routing map below.
    const servers = getServers();
    const perServer = await Promise.all(
      servers.map(s => listFromServer(s.name, ctx.bearerToken, metadata)),
    );

    // Merge with collision detection. Hard rule #1: the same name
    // appearing in two catalogs is a startup-time error.
    const merged: McpTool[] = [];
    for (let i = 0; i < servers.length; i += 1) {
      const serverEntry = servers[i];
      const tools = perServer[i];
      if (!serverEntry || !tools) continue;
      for (const tool of tools) {
        setToolRouting(tool.name, serverEntry.name);
        merged.push(tool);
      }
    }

    const filtered = merged.filter(t => isToolPermitted(t, ctx.permissions));
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

/** Test-only — clear the catalog cache between cases. */
export function _resetToolDiscoveryCache(): void {
  cache.clear();
}
