import type { Tool as McpTool } from '@modelcontextprotocol/sdk/types.js';
import { getMcpClient } from './client.js';
import { isToolPermitted } from './tool-permissions.js';
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

export async function discoverTools(ctx: BotAuthContext): Promise<McpTool[]> {
  const key = cacheKey(ctx);
  const cached = cache.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached.tools;

  const client = await getMcpClient(ctx.bearerToken);
  const result = await client.listTools();

  // Slice 43: filter via the centralized TOOL_PERMISSIONS map (mirrors
  // the in-handler assertPermission / role checks in hr-service). Server-
  // side gates remain authoritative; this just hides tools the user
  // can't invoke from the LLM's catalog.
  const tools = result.tools.filter(tool =>
    isToolPermitted(tool.name, ctx.permissions, ctx.roles ?? []),
  );

  cache.set(key, { tools, expiresAt: Date.now() + TTL });
  return tools;
}
