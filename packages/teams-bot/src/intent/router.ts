import type { Tool as McpTool } from '@modelcontextprotocol/sdk/types.js';
import { createLiteLLMClient } from '@cip/shared';
import type { BotAuthContext } from '../auth/resolve-context.js';

export async function routeIntent(
  message: string,
  tools: McpTool[],
  ctx: BotAuthContext,
): Promise<{ name: string; args: Record<string, unknown> } | null> {
  const client = createLiteLLMClient({
    tenantId: ctx.tenantId,
    virtualKey: ctx.tenantConfig.litellmVirtualKey,
  });

  const response = await client.chat.completions.create({
    model: 'cip-chat',
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
  });

  const call = response.choices[0]?.message.tool_calls?.[0];
  if (!call) return null;
  return {
    name: call.function.name,
    args: JSON.parse(call.function.arguments) as Record<string, unknown>,
  };
}
