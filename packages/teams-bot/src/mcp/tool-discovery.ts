import type { Tool as McpTool } from '@modelcontextprotocol/sdk/types.js';
import { getMcpClient } from './client.js';
import type { BotAuthContext } from '../auth/resolve-context.js';

interface CacheEntry {
  tools: McpTool[];
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const TTL = 5 * 60 * 1000;

export async function discoverTools(ctx: BotAuthContext): Promise<McpTool[]> {
  const cached = cache.get(ctx.tenantId);
  if (cached && Date.now() < cached.expiresAt) return cached.tools;

  const client = await getMcpClient(ctx.bearerToken);
  const result = await client.listTools();

  const tools = result.tools.filter(tool => {
    const requiredPerm = (tool.annotations as Record<string, unknown> | undefined)?.[
      'requiredPermission'
    ] as string | undefined;
    if (!requiredPerm) return true;
    return ctx.permissions[requiredPerm] === true;
  });

  cache.set(ctx.tenantId, { tools, expiresAt: Date.now() + TTL });
  return tools;
}
