// Slice 56F: /turn-feedback handler — records the user's verdict on a
// bot turn. Fired by the 👍/👎 buttons on the response-footer adaptive
// card built by debug-banner.ts.
//
// Two payload shapes:
//   /turn-feedback <8-char-id> positive
//   /turn-feedback <8-char-id> negative                          ← shows follow-up card
//   /turn-feedback <8-char-id> negative <free-text correction>   ← submitted from the follow-up card
//
// The first two arrive from the initial 👍 / 👎 button taps. The third
// arrives from the follow-up card's Submit action (the user typed what
// the bot should have done). No text reply on the positive path —
// silently records the verdict so the channel doesn't fill with bot
// noise. Negative-without-correction triggers the follow-up card.

import { executeTool } from '../../mcp/tool-executor.js';
import { buildFeedbackCorrectionCard } from '../../intent/feedback-correction-card.js';
import type { SlashCommandHandlerArgs, SlashCommandResult } from '../registry.js';

const ID_RE = /^[0-9a-f]{8}$/;

export async function turnFeedbackHandler(args: SlashCommandHandlerArgs): Promise<SlashCommandResult> {
  const after = args.text.trim().slice('/turn-feedback'.length).trim();
  if (!after) {
    return { reply: '`/turn-feedback <id> positive|negative [correction]` — usually fired by tapping 👍/👎 on a footer card.' };
  }

  // Parse: <id> <verdict> [...correction]
  const parts = after.split(/\s+/);
  const turnId  = (parts[0] ?? '').toLowerCase();
  const verdict = (parts[1] ?? '').toLowerCase();
  const correction = parts.slice(2).join(' ').trim();

  if (!ID_RE.test(turnId)) {
    return { reply: `\`${turnId}\` doesn't look like a turn id (8 hex chars).` };
  }
  if (verdict !== 'positive' && verdict !== 'negative') {
    return { reply: `verdict must be \`positive\` or \`negative\`; got \`${verdict}\`.` };
  }

  // Negative without correction → render the follow-up card asking what
  // should have happened. Don't record yet — wait for the user to either
  // submit or skip. (If they skip, no row written; the importer's
  // skip-rule for verdict='negative' AND correction=null protects us.)
  if (verdict === 'negative' && correction.length === 0) {
    return {
      reply: '_What should it have done?_',
      card:  buildFeedbackCorrectionCard({ turnId }),
    };
  }

  // Record verdict (positive, or negative-with-correction).
  try {
    const result = await executeTool(
      'bot_turn_feedback_record',
      {
        turn_id: turnId,
        verdict,
        ...(correction ? { correction } : {}),
      },
      args.ctx,
    ) as { ok?: boolean; data?: { recorded?: boolean }; message?: string; code?: string };

    if (result.ok === false) {
      return { reply: `Couldn't record feedback: ${result.message ?? result.code ?? 'unknown error'}.` };
    }

    if (verdict === 'positive') {
      // Silent acknowledgement — single character of confirmation. We
      // don't want every 👍 to spam the channel with full sentences.
      return { reply: '👍 _Thanks — recorded._' };
    }
    // Negative WITH correction submitted.
    return {
      reply: '👎 _Recorded with your correction. This will help train the next model._',
    };
  } catch (err) {
    return { reply: `Error recording feedback: ${err instanceof Error ? err.message : String(err)}` };
  }
}
