// Slice 43: dedicated meta_compose call. The bot's classifier returns
// intent='meta' for "what can you do?" / "list tools" / "help me" — this
// module makes a *second* LLM call with the user's permitted tool list
// as context and asks it to compose a short markdown menu.
//
// Why a separate call (not the classifier's inline_reply): the previous
// design overloaded the small classifier model to both classify AND
// compose, with conflicting prompt instructions. The model produced
// truncated or off-script output ("Here are the tools you can use:" with
// nothing after). Splitting concerns lets the classifier do what it's
// good at (3-label decision) and the meta_compose call do what it's good
// at (short text composition with structured input).
//
// Why not a deterministic static menu (the b240cb8 approach): the static
// `CATEGORY_USER_HELP` map was hand-curated and would drift the same way
// `TOOLS_FOR_CATEGORY` did. With LLM composition, adding a new tool with
// a good description automatically flows into the meta reply — no
// parallel registry.

import type { Tool as McpTool } from '@modelcontextprotocol/sdk/types.js';
import { callLLM, createLiteLLMClient, getPrompt } from '@cip/shared';
import { resolveAlias } from './alias-resolver.js';
import type { BotAuthContext } from '../auth/resolve-context.js';

const FALLBACK_REPLY =
  "I can help with HR and certification tasks. Try asking about your " +
  "certifications, your roles, or — if you're an admin — managing employees.";

export interface MetaResult {
  reply: string;
  alias: string | null;   // null on fallback / failure
}

/**
 * Compose a user-facing menu from the permitted tool list. Returns a
 * graceful fallback string on any failure — the meta path must never
 * crash the turn.
 */
export async function composeMetaReply(
  ctx:   BotAuthContext,
  tools: McpTool[],
): Promise<MetaResult> {
  if (tools.length === 0) {
    return {
      reply: "I don't have any tools available for your account right now. " +
             "Please contact your administrator.",
      alias: null,
    };
  }

  let alias: string | null = null;
  try {
    alias = await resolveAlias({ purpose: 'meta_compose', tenantId: ctx.tenantId });
    const prompt = await getPrompt({ name: 'bot.meta_compose', tenantId: ctx.tenantId });
    const client = createLiteLLMClient({
      tenantId:   ctx.tenantId,
      virtualKey: ctx.tenantConfig.litellmVirtualKey,
    });

    // Pass tool name + description (no params — they're an implementation
    // detail the user doesn't need to see in the menu).
    const toolList = tools.map(t => ({
      name:        t.name,
      description: t.description ?? '',
    }));

    const resp = await callLLM(client, {
      model:    alias,
      messages: [
        { role: 'system', content: prompt.compile({ tools: toolList }) },
      ],
      temperature: 0.3,
      // Bounded: a short markdown menu (~5 bullets, ~150 words). 1024
      // covers the longest plausible response with headroom.
      max_tokens: 1024,
      purpose:      'bot.meta_compose',
      promptHandle: prompt,
      tenantId:     ctx.tenantId,
    });

    const reply = resp.choices[0]?.message.content?.trim();
    if (!reply) {
      console.warn('[meta_compose] empty response — using fallback');
      return { reply: FALLBACK_REPLY, alias };
    }
    return { reply, alias };
  } catch (err) {
    console.warn(
      `[meta_compose] failed, using fallback: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { reply: FALLBACK_REPLY, alias };
  }
}
