import type { Tool as McpTool } from '@modelcontextprotocol/sdk/types.js';
import { callLLM, createLiteLLMClient } from '@cip/shared';
import type { BotAuthContext } from '../auth/resolve-context.js';
import { resolveAlias } from './alias-resolver.js';

// Slice 39A: the bot still does single-stage routing today — purpose is
// 'route_simple', resolved through routing_rules. Slice 39B introduces
// the classifier and route_careful / route_reasoning purposes.
export async function routeIntent(
  message: string,
  tools: McpTool[],
  ctx: BotAuthContext,
): Promise<{ name: string; args: Record<string, unknown> } | null> {
  const alias = await resolveAlias({ purpose: 'route_simple', tenantId: ctx.tenantId });
  const client = createLiteLLMClient({
    tenantId:   ctx.tenantId,
    virtualKey: ctx.tenantConfig.litellmVirtualKey,
  });

  const response = await callLLM(client, {
    model: alias,
    messages: [{ role: 'user', content: message }],
    tools: tools.map(t => ({
      type: 'function' as const,
      function: {
        name: t.name,
        ...(t.description ? { description: t.description } : {}),
        parameters: t.inputSchema as Record<string, unknown>,
      },
    })),
    tool_choice: 'auto',
    purpose:  'bot.route_simple',
    tenantId: ctx.tenantId,
  });

  const call = response.choices[0]?.message.tool_calls?.[0];
  if (!call) return null;
  return {
    name: call.function.name,
    args: JSON.parse(call.function.arguments) as Record<string, unknown>,
  };
}
