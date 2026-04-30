// Slice 39B: Stage-1 intent classifier.
// Tiny LLM call to categorise the user's message; for chitchat/meta it
// also emits the user-facing reply so Stage 2 can be skipped entirely.

import { z } from 'zod';
import type { Tool as McpTool } from '@modelcontextprotocol/sdk/types.js';
import { callLLM, createLiteLLMClient, getPrompt } from '@cip/shared';
import { resolveAlias } from './alias-resolver.js';
import { CATEGORIES, availableCategories, type Category } from './tool-categories.js';
import type { BotAuthContext } from '../auth/resolve-context.js';

const ClassificationSchema = z.object({
  category:     z.enum(CATEGORIES),
  complexity:   z.enum(['simple', 'reasoning']),
  inline_reply: z.string().optional(),
});

export type Classification = z.infer<typeof ClassificationSchema>;

export interface ClassifyResult {
  classification: Classification | null;  // null when LLM/parse failed → caller falls back
  alias:          string | null;          // alias used; null only when alias resolution failed
}

// Slice 41: system prompt fetched from Langfuse via getPrompt(). Fallback
// lives in @cip/shared/src/clients/prompts/bot-intent-classify.ts.
//
// Permission-aware classification: derive per-category availability from
// the tools that actually survived permission filtering, then pass those
// flags into the Jinja2 prompt. Single source of truth — no separate
// permission-to-category mapping to drift. Adding a new tool with a
// `requiredPermission` annotation automatically flows through to the
// classifier prompt's enum.
function buildClassifierVars(tools: McpTool[]): Record<string, unknown> {
  const cats = availableCategories(tools);
  return {
    // chitchat / meta / reasoning are always available (no tool gating).
    hasCertQuery:  cats.cert_query,
    hasCertSubmit: cats.cert_action,
    hasHrAdmin:    cats.hr_admin,
  };
}

export async function classify(
  message: string,
  ctx:     BotAuthContext,
  tools:   McpTool[],     // already permission-filtered by tool-discovery
): Promise<ClassifyResult> {
  // Wrap EVERYTHING — alias resolution, LLM call, JSON parse, Zod validation —
  // so any failure (LiteLLM 4xx/5xx, network drop, malformed JSON, schema
  // mismatch) returns { classification: null, alias }. The bot's caller treats
  // classification=null as "use legacy single-stage routing", keeping the turn
  // working even when classification breaks.
  let alias: string | null = null;
  try {
    alias = await resolveAlias({
      purpose:  'intent_classify',
      tenantId: ctx.tenantId,
    });
    const prompt = await getPrompt({ name: 'bot.intent_classify', tenantId: ctx.tenantId });
    const client = createLiteLLMClient({
      tenantId:   ctx.tenantId,
      virtualKey: ctx.tenantConfig.litellmVirtualKey,
    });

    const resp = await callLLM(client, {
      model: alias,
      messages: [
        { role: 'system', content: prompt.compile(buildClassifierVars(tools)) },
        { role: 'user',   content: message },
      ],
      response_format: { type: 'json_object' },
      temperature: 0,
      purpose:      'bot.intent_classify',
      promptHandle: prompt,
      tenantId:     ctx.tenantId,
    });

    const text = resp.choices[0]?.message.content ?? '';
    return {
      classification: ClassificationSchema.parse(JSON.parse(text)),
      alias,
    };
  } catch (err) {
    console.warn(`[classifier] failed, falling back to legacy routing: ${err instanceof Error ? err.message : String(err)}`);
    return { classification: null, alias };
  }
}
