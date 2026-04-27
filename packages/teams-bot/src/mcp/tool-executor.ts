import type { McpModuleResponse } from '@cip/shared';
import { getMcpClient } from './client.js';
import type { BotAuthContext } from '../auth/resolve-context.js';

function extractText(content: unknown): string {
  if (!Array.isArray(content)) return '{}';
  for (const item of content as Array<{ type?: unknown; text?: unknown }>) {
    if (item.type === 'text' && typeof item.text === 'string') return item.text;
  }
  return '{}';
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: BotAuthContext,
): Promise<McpModuleResponse> {
  // tenantId flows through the bearer token, not as a tool argument (non-negotiable #6)
  const client = await getMcpClient(ctx.bearerToken);
  const result = await client.callTool({ name, arguments: args });
  return JSON.parse(extractText(result.content)) as McpModuleResponse;
}
