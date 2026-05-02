// Slice 45: triage node — non-binding signals via the cheap classifier
// model. Output strictly conforms to TriageSignals (Zod-validated). On
// any failure: log, fall back to {needsTool: true, confidence: 0} so the
// planner still runs.

import { z } from 'zod';
import { callLLM, createLiteLLMClient, getPrompt } from '@cip/shared';
import { resolveAlias } from '../../intent/alias-resolver.js';
import { type State, type TriageSignals } from '../state.js';
import type { BotAuthContext } from '../../auth/resolve-context.js';

const TriageSchema = z.object({
  needsTool:             z.boolean(),
  answerDirectly:        z.boolean(),
  needsClarification:    z.boolean(),
  currentGoal:           z.string(),
  knownEntities:         z.record(z.string()),
  confidence:            z.number().min(0).max(1),
  clarificationQuestion: z.string().optional(),
});

const FALLBACK: TriageSignals = {
  needsTool:          true,
  answerDirectly:     false,
  needsClarification: false,
  currentGoal:        '',
  knownEntities:      {},
  confidence:         0,
};

export function makeTriageNode(ctx: BotAuthContext) {
  return async function triage(state: State): Promise<Partial<State>> {
    try {
      const alias = await resolveAlias({ purpose: 'intent_classify', tenantId: state.tenantId });
      const prompt = await getPrompt({ name: 'bot.triage', tenantId: state.tenantId });
      const client = createLiteLLMClient({
        tenantId:   state.tenantId,
        virtualKey: ctx.tenantConfig.litellmVirtualKey,
      });

      // Last 4 prior messages as context for the triage. We don't use
      // lg.max_recent_messages here — triage only needs immediate context;
      // the longer history is the planner's job.
      const recent = state.messages
        .slice(-5, -1)
        .map(m => ({
          role:    m.getType() === 'human' ? 'user' : m.getType() === 'ai' ? 'assistant' : 'tool',
          content: typeof m.content === 'string' ? m.content : '',
        }));

      const resp = await callLLM(client, {
        model: alias,
        // Mistral rejects single-message (system-only) conversations with
        // 400 "Conversation must have at least one message". Always include
        // the user's latest text as a user turn alongside the system prompt.
        messages: [
          {
            role: 'system',
            content: prompt.compile({
              recent,
              summary: state.summary,
              latest:  state.latestUserText,
            }),
          },
          { role: 'user', content: state.latestUserText },
        ],
        response_format: { type: 'json_object' },
        temperature:     0,
        max_tokens:      512,
        purpose:         'bot.triage',
        promptHandle:    prompt,
        tenantId:        state.tenantId,
        sessionId:       state.sessionId,
      });

      const text = resp.choices[0]?.message.content ?? '';
      const parsed = TriageSchema.parse(JSON.parse(text));
      const signals: TriageSignals = {
        needsTool:          parsed.needsTool,
        answerDirectly:     parsed.answerDirectly,
        needsClarification: parsed.needsClarification,
        currentGoal:        parsed.currentGoal,
        knownEntities:      parsed.knownEntities,
        confidence:         parsed.confidence,
        ...(parsed.clarificationQuestion ? { clarificationQuestion: parsed.clarificationQuestion } : {}),
      };
      return { triageSignals: signals };
    } catch (err) {
      console.warn(
        `[triage] failed, using fallback: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { triageSignals: FALLBACK };
    }
  };
}
