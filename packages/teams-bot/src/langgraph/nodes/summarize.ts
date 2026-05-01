// Slice 46: summarize node — compresses the older portion of a long
// conversation into state.summary so that subsequent turns don't re-send
// the entire history to the planner.
//
// Trigger: graph edge after `respond` routes here when
// `state.messages.length > lg.summarize_at` (default 12). When it does:
//   1. Pick the oldest N messages where N = messages.length - lg.summarize_keep_recent.
//   2. Call cip-classifier (nemo) with the bot.summarize prompt.
//   3. Append the output to state.summary, capped at lg.summary_max_chars.
//   4. Replace the older messages with a single SystemMessage carrying
//      "[Earlier conversation summarized]" so the message log stays
//      internally consistent and the planner sees a clear seam.
//
// Hard rules (per slice doc):
//   - The summarize call ALWAYS sends a system + user message. Never
//     single-system-message (Mistral rejects that with 400 — and per
//     LLM_PROVIDER_NOTES.md we treat this as canonical chat-completion shape).
//   - Failure is non-fatal: the turn already responded; we just don't
//     compress this time. Log + continue.

import { SystemMessage, RemoveMessage, type BaseMessage } from '@langchain/core/messages';
import { callLLM, createLiteLLMClient, getPrompt } from '@cip/shared';
import { resolveAlias } from '../../intent/alias-resolver.js';
import { getTunables, getTunable } from '../tunables.js';
import { type State } from '../state.js';
import type { BotAuthContext } from '../../auth/resolve-context.js';

export function makeSummarizeNode(ctx: BotAuthContext) {
  return async function summarize(state: State): Promise<Partial<State>> {
    try {
      const tunables = await getTunables(state.tenantId);
      const summarizeAt = getTunable<number>(tunables, 'lg.summarize_at', 12);
      const keepRecent  = getTunable<number>(tunables, 'lg.summarize_keep_recent', 6);
      const maxChars    = getTunable<number>(tunables, 'lg.summary_max_chars', 2000);

      // Defensive — the routing edge already checked, but being a no-op
      // when the threshold isn't crossed costs nothing and keeps the node
      // safe to call directly from tests.
      if (summarizeAt <= 0 || state.messages.length <= summarizeAt) return {};
      if (state.messages.length <= keepRecent) return {};

      // Adjust the cutoff so `recent` doesn't start with a ToolMessage
      // (orphaned tool result whose parent AIMessage just got summarized
      // away — that combo trips Mistral's
      // "Unexpected role 'tool' after role 'system'" check on the next
      // planner call).
      let cutoff = state.messages.length - keepRecent;
      while (cutoff < state.messages.length && state.messages[cutoff]!.getType() === 'tool') {
        cutoff++;
      }
      if (cutoff >= state.messages.length) return {};
      const olderMessages = state.messages.slice(0, cutoff);

      const excerpt = olderMessages
        .map(m => `${roleOf(m)}: ${stringContent(m)}`)
        .join('\n');

      const alias = await resolveAlias({ purpose: 'summarize', tenantId: state.tenantId });
      const prompt = await getPrompt({ name: 'bot.summarize', tenantId: state.tenantId });
      const client = createLiteLLMClient({
        tenantId:   state.tenantId,
        virtualKey: ctx.tenantConfig.litellmVirtualKey,
      });

      const resp = await callLLM(client, {
        model: alias,
        messages: [
          {
            role: 'system',
            content: prompt.compile({
              prior_summary: state.summary,
              max_chars:     maxChars,
            }),
          },
          { role: 'user', content: excerpt },
        ],
        temperature:  0.2,
        max_tokens:   600,
        purpose:      'bot.summarize',
        promptHandle: prompt,
        tenantId:     state.tenantId,
      });

      const newPara = (resp.choices[0]?.message.content ?? '').trim();
      if (!newPara) return {};

      const merged = mergeSummary(state.summary, newPara, maxChars);

      // messagesStateReducer in LangGraph 1.x APPENDS by default. To trim
      // the older tail we must emit a RemoveMessage(id) for each older
      // message; the recent tail stays in place untouched. We then append
      // a single SystemMessage to mark the seam.
      // (Returning [SystemMessage, ...recent] would just duplicate recent.)
      const removals = olderMessages
        .filter(m => m.id)
        .map(m => new RemoveMessage({ id: m.id! }));

      return {
        summary:  merged,
        messages: [
          ...removals,
          new SystemMessage('[Earlier conversation summarized]'),
        ],
      };
    } catch (err) {
      console.warn(
        `[summarize] failed, leaving state.summary unchanged: ${err instanceof Error ? err.message : String(err)}`,
      );
      return {};
    }
  };
}

/**
 * Conditional edge function — placed after `respond`. Returns 'summarize'
 * to route into the summarize node, or 'end' to terminate.
 *
 * Resolves the threshold per-tenant via tunables. Async because
 * `getTunables` is async; LangGraph supports async conditional edges.
 */
export async function shouldSummarize(state: State): Promise<'summarize' | 'end'> {
  const tunables = await getTunables(state.tenantId);
  const summarizeAt = getTunable<number>(tunables, 'lg.summarize_at', 12);
  if (summarizeAt > 0 && state.messages.length > summarizeAt) return 'summarize';
  return 'end';
}

function roleOf(m: BaseMessage): string {
  const t = m.getType();
  if (t === 'human') return 'user';
  if (t === 'ai')    return 'assistant';
  if (t === 'tool')  return 'tool';
  return 'system';
}

function stringContent(m: BaseMessage): string {
  return typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
}

/**
 * Merge a fresh summary paragraph into the existing one. If the merged
 * length exceeds maxChars, drop earliest paragraphs until it fits.
 */
function mergeSummary(prior: string, fresh: string, maxChars: number): string {
  const combined = prior ? `${prior}\n\n${fresh}` : fresh;
  if (combined.length <= maxChars) return combined;

  const paras = combined.split(/\n{2,}/).filter(Boolean);
  while (paras.length > 1 && paras.join('\n\n').length > maxChars) {
    paras.shift();
  }
  // If a single paragraph still exceeds the cap, hard-truncate.
  return paras.join('\n\n').slice(-maxChars);
}
