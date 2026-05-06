// Slice 56F + 61: /turn-feedback handler — records the user's verdict
// on a bot turn. Fired by the 👍/👎 buttons on the response-footer
// adaptive card built by debug-banner.ts.
//
// Slice 61: rewritten to write a Langfuse trace score instead of the
// dropped bot_turn_feedback table. Score `turn_verdict` (1 for positive,
// 0 for negative) is attached to the trace whose ID matches turnId.
// The score becomes filterable in Langfuse: weekly review of low-scored
// traces drives prompt iteration, replacing the retrain workflow.
//
// Two payload shapes (correction follow-up removed in 61 along with the
// feedback-correction card):
//   /turn-feedback <8-char-id> positive
//   /turn-feedback <8-char-id> negative

import { getLangfuse } from '@cip/shared';
import type { SlashCommandHandlerArgs, SlashCommandResult } from '../registry.js';

const ID_RE = /^[0-9a-f]{8}$/;

export async function turnFeedbackHandler(args: SlashCommandHandlerArgs): Promise<SlashCommandResult> {
  const after = args.text.trim().slice('/turn-feedback'.length).trim();
  if (!after) {
    return { reply: '`/turn-feedback <id> positive|negative` — usually fired by tapping 👍/👎 on a footer card.' };
  }

  const parts = after.split(/\s+/);
  const turnId  = (parts[0] ?? '').toLowerCase();
  const verdict = (parts[1] ?? '').toLowerCase();

  if (!ID_RE.test(turnId)) {
    return { reply: `\`${turnId}\` doesn't look like a turn id (8 hex chars).` };
  }
  if (verdict !== 'positive' && verdict !== 'negative') {
    return { reply: `verdict must be \`positive\` or \`negative\`; got \`${verdict}\`.` };
  }

  // Resolve the Langfuse trace id for this turn. The runner persists
  // the OTEL-assigned trace UUID in bot_turn_metrics.langfuse_trace_id
  // alongside the 8-char turn id. We score the trace by its Langfuse
  // UUID, not the turn id (which is just a user-facing handle).
  //
  // We fetch via the bot_metrics_get_turn MCP tool to keep tenant scoping
  // server-side rather than the bot reaching directly into the DB.
  let traceId: string;
  try {
    const { executeTool } = await import('../../mcp/tool-executor.js');
    const result = await executeTool(
      'bot_metrics_get_turn',
      { turn_id: turnId },
      args.ctx,
    ) as { data?: { langfuse_trace_id?: string | null }; refused?: string; message?: string };

    if (result.refused) {
      return { reply: `Couldn't fetch turn ${turnId}: ${result.refused}.` };
    }
    if (!result.data || !result.data.langfuse_trace_id) {
      return { reply: `No Langfuse trace recorded for turn ${turnId} — verdict not saved.` };
    }
    traceId = result.data.langfuse_trace_id;
  } catch (err) {
    return { reply: `Error looking up turn ${turnId}: ${err instanceof Error ? err.message : String(err)}` };
  }

  // Score the trace. Best-effort: a Langfuse outage shouldn't fail the
  // user-visible click. If LANGFUSE_PUBLIC_KEY/SECRET_KEY aren't set,
  // getLangfuse() throws — we catch and surface a friendly error.
  try {
    const lf = getLangfuse();
    await lf.score({
      traceId,
      name:    'turn_verdict',
      value:   verdict === 'positive' ? 1 : 0,
      comment: `User feedback from /turn-feedback (${verdict})`,
    });
  } catch (err) {
    return { reply: `Couldn't record verdict: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (verdict === 'positive') {
    return { reply: '👍 _Thanks — recorded._' };
  }
  return { reply: '👎 _Recorded._' };
}
