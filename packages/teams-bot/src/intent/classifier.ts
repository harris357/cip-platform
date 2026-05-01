// Slice 39B: Stage-1 intent classifier.
// Slice 43: collapsed to 3 intents (chitchat | meta | proceed).
// chitchat keeps the LLM-authored inline_reply for free-form social.
// meta no longer carries an inline_reply — the bot makes a dedicated
// `meta_compose` LLM call after seeing this label. proceed always
// hands off to the router with the full permitted tool catalog.

import { z } from 'zod';
import type { Tool as McpTool } from '@modelcontextprotocol/sdk/types.js';
import { callLLM, createLiteLLMClient, getPrompt } from '@cip/shared';
import { resolveAlias } from './alias-resolver.js';
import { INTENTS, availableIntents, type Intent } from './tool-categories.js';
import type { BotAuthContext } from '../auth/resolve-context.js';

// Even at temperature: 0 small models occasionally invent a label name
// that fits the user's intent semantically (e.g., "capabilities" instead
// of "meta"). Accept any string, then coerce: known aliases map to a
// canonical intent; unknown strings default to "meta" if the model
// produced an inline_reply (looked like it was answering a meta query),
// otherwise "proceed" — the safe default that hands off to the router.
const INTENT_ALIASES: Record<string, Intent> = {
  capabilities: 'meta',
  help:         'meta',
  about:        'meta',
  introduction: 'meta',
  greeting:     'chitchat',
  social:       'chitchat',
  hello:        'chitchat',
  reasoning:    'proceed',
  cert_query:   'proceed',
  cert_action:  'proceed',
  hr_admin:     'proceed',
};

const ClassificationSchema = z
  .object({
    intent: z.string(),
    // Models inconsistently return undefined / null / "" / a string. Accept
    // any of those — null and "" are both treated as "no inline reply"
    // downstream. nullable() handles the literal `null` JSON value the
    // classifier emits even when the prompt says to omit the field.
    inline_reply: z.string().nullable().optional(),
  })
  .transform((v) => {
    const lower = v.intent.toLowerCase().trim();
    const reply = v.inline_reply == null || v.inline_reply === '' ? undefined : v.inline_reply;
    let intent: Intent;
    if ((INTENTS as readonly string[]).includes(lower)) {
      intent = lower as Intent;
    } else if (INTENT_ALIASES[lower]) {
      intent = INTENT_ALIASES[lower];
      console.warn(`[classifier] coerced unknown intent "${v.intent}" → "${intent}" (alias)`);
    } else {
      intent = reply ? 'meta' : 'proceed';
      console.warn(`[classifier] coerced unknown intent "${v.intent}" → "${intent}" (default)`);
    }
    return { intent, inline_reply: reply };
  });

export type Classification = z.infer<typeof ClassificationSchema>;

export interface ClassifyResult {
  classification: Classification | null;  // null when LLM/parse failed → caller falls back
  alias:          string | null;          // alias used; null only when alias resolution failed
}

function buildClassifierVars(tools: McpTool[]): Record<string, unknown> {
  return {
    intents: availableIntents(tools),
  };
}

export async function classify(
  message: string,
  ctx:     BotAuthContext,
  tools:   McpTool[],
): Promise<ClassifyResult> {
  // Wrap EVERYTHING — alias resolution, LLM call, JSON parse, Zod validation —
  // so any failure (LiteLLM 4xx/5xx, network drop, malformed JSON, schema
  // mismatch) returns { classification: null, alias }. The caller treats
  // classification=null as "fall back to proceed", keeping the turn working
  // even when classification breaks.
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
      // 512 is plenty: a 3-label classifier with optional one-line
      // chitchat reply never needs more. Caps Mistral's open-ended
      // default that occasionally produced runaway output before.
      max_tokens: 512,
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
    console.warn(`[classifier] failed, falling back to proceed: ${err instanceof Error ? err.message : String(err)}`);
    return { classification: null, alias };
  }
}
