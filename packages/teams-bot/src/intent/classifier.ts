// Slice 39B: Stage-1 intent classifier.
// Tiny LLM call to categorise the user's message; for chitchat/meta it
// also emits the user-facing reply so Stage 2 can be skipped entirely.

import { z } from 'zod';
import { callLLM, createLiteLLMClient } from '@cip/shared';
import { resolveAlias } from './alias-resolver.js';
import { CATEGORIES, type Category } from './tool-categories.js';
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

const SYSTEM_PROMPT = `
You are a fast intent classifier for a workplace HR/compliance bot.
Classify the user's message into exactly one category:

- "chitchat"    : greetings, thanks, social pleasantries. Emit a brief
                  friendly inline_reply (1 sentence).
- "meta"        : questions about the bot itself ("what can you do?",
                  "help"). Emit a one-paragraph inline_reply describing
                  the bot's capabilities at a high level.
- "cert_query"  : the user wants to read certification or compliance data.
- "cert_action" : the user wants to upload/submit/approve a certificate.
- "hr_admin"    : the user wants to manage employees, roles, or permissions.
- "reasoning"   : multi-step intents that span categories, or anything
                  unclear. Use sparingly — only when no single category fits.

Set complexity:
- "simple"   : one tool call should answer this.
- "reasoning": likely needs multiple tools or planning.

Return ONLY a JSON object matching this schema. No prose, no markdown.

{
  "category": "<one of the above>",
  "complexity": "<simple|reasoning>",
  "inline_reply": "<only set for chitchat/meta>"
}
`.trim();

export async function classify(
  message: string,
  ctx: BotAuthContext,
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
    const client = createLiteLLMClient({
      tenantId:   ctx.tenantId,
      virtualKey: ctx.tenantConfig.litellmVirtualKey,
    });

    const resp = await callLLM(client, {
      model: alias,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: message },
      ],
      response_format: { type: 'json_object' },
      temperature: 0,
      purpose:  'bot.intent_classify',
      tenantId: ctx.tenantId,
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
