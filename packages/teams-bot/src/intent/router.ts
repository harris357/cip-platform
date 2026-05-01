import type { Tool as McpTool } from '@modelcontextprotocol/sdk/types.js';
import { callLLM, createLiteLLMClient } from '@cip/shared';
import { resolveAlias } from './alias-resolver.js';
import { PURPOSE_FOR_CATEGORY, type Category } from './tool-categories.js';
import type { BotAuthContext } from '../auth/resolve-context.js';

export interface RouteResult {
  selected: { name: string; args: Record<string, unknown> } | null;
  alias:    string;   // exposed so bot.ts can include in the debug banner
}

// Slice 39B: Stage-2 tool selection. Caller (bot.ts) has already run
// the Stage-1 classifier; this picks a tool from a category-filtered
// catalog using the alias resolved per-category.
export async function routeIntent(args: {
  message:  string;
  category: Category;
  tools:    McpTool[];   // already filtered by category + permissions
  ctx:      BotAuthContext;
}): Promise<RouteResult> {
  const purpose = PURPOSE_FOR_CATEGORY[args.category];
  if (!purpose) {
    // Inline-only categories (chitchat/meta) should have been handled by
    // the bot's inline-reply path before reaching here. If we got here,
    // upstream logic missed an inline-only category — log and degrade
    // gracefully (no-tool reply) rather than crash the turn.
    console.warn(`[router] routeIntent called with inline-only category=${args.category}; upstream path should have handled this. Returning no tool selected.`);
    return { selected: null, alias: 'inline-only' };
  }
  const alias = await resolveAlias({ purpose, tenantId: args.ctx.tenantId });
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
    purpose:  `bot.${purpose}`,
    tenantId: args.ctx.tenantId,
  });

  const call = resp.choices[0]?.message.tool_calls?.[0];
  const selected = call ? {
    name: call.function.name,
    args: JSON.parse(call.function.arguments) as Record<string, unknown>,
  } : null;
  return { selected, alias };
}
