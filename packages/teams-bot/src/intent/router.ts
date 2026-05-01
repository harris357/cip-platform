import type { Tool as McpTool } from '@modelcontextprotocol/sdk/types.js';
import { callLLM, createLiteLLMClient } from '@cip/shared';
import { resolveAlias } from './alias-resolver.js';
import type { BotAuthContext } from '../auth/resolve-context.js';

export interface RouteResult {
  selected: { name: string; args: Record<string, unknown> } | null;
  alias:    string;   // exposed so bot.ts can include in the response footer
}

// Slice 43: tool selection over the full permission-filtered catalog.
// No more per-category subsets or per-purpose aliases — one alias
// (`route`, default mistral-small-latest) reads every permitted tool's
// description and picks the one whose scope/audience/output best fits
// the user's request. Disambiguation lives in the descriptions themselves
// (see SLICE_43 doc), not in a category map.
export async function routeIntent(args: {
  message: string;
  tools:   McpTool[];   // already permission-filtered by tool-discovery
  ctx:     BotAuthContext;
}): Promise<RouteResult> {
  const alias = await resolveAlias({ purpose: 'route', tenantId: args.ctx.tenantId });
  const client = createLiteLLMClient({
    tenantId:   args.ctx.tenantId,
    virtualKey: args.ctx.tenantConfig.litellmVirtualKey,
  });

  const resp = await callLLM(client, {
    model: alias,
    messages: [{ role: 'user', content: args.message }],
    tools: args.tools.map(t => ({
      type: 'function' as const,
      function: {
        name: t.name,
        ...(t.description ? { description: t.description } : {}),
        parameters: t.inputSchema as Record<string, unknown>,
      },
    })),
    tool_choice: 'auto',
    purpose:  'bot.route',
    tenantId: args.ctx.tenantId,
  });

  const call = resp.choices[0]?.message.tool_calls?.[0];
  const selected = call ? {
    name: call.function.name,
    args: JSON.parse(call.function.arguments) as Record<string, unknown>,
  } : null;
  return { selected, alias };
}
