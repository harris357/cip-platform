import type { McpModuleResponse } from '@cip/shared';
import { getMcpClientFor, getServerForTool, type ServerName } from './multi-server-client.js';
import type { BotAuthContext } from '../auth/resolve-context.js';

function extractText(content: unknown): string {
  if (!Array.isArray(content)) return '{}';
  for (const item of content as Array<{ type?: unknown; text?: unknown }>) {
    if (item.type === 'text' && typeof item.text === 'string') return item.text;
  }
  return '{}';
}

/**
 * Execute a tool by name on whichever MCP server registered it.
 *
 * Slice 58B-2b: routing is driven by the table populated at
 * discoverTools() time. If the tool name isn't in the table, we
 * fall back to hr-service — the legacy behaviour, and the right
 * default for any tool the bot calls before the catalog is warm
 * (e.g. tools used during resolveAuthContext).
 *
 * tenantId flows through the bearer token, NOT as a tool argument
 * (non-negotiable #6).
 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: BotAuthContext,
): Promise<McpModuleResponse> {
  const server: ServerName = getServerForTool(name) ?? 'hr-service';
  const client = await getMcpClientFor(server, ctx.bearerToken);
  const result = await client.callTool({ name, arguments: args });
  return JSON.parse(extractText(result.content)) as McpModuleResponse;
}
