// Slice 56F: MCP tool for recording user verdict on a bot turn.
//
// Two paths into this tool:
//   1. User taps 👍 / 👎 on the response footer adaptive card (the most
//      common path). The bot's slash dispatcher routes
//      `/turn-feedback <turnId> positive|negative` here.
//   2. User submits a correction via the follow-up card after 👎. The
//      slash dispatcher routes `/turn-feedback <turnId> negative <text>`
//      here with the text as the `correction`.
//
// Permission: NONE. Any authenticated user can record feedback on their
// own tenant's turns. The DB query is tenant-scoped — a user can't
// verdict another tenant's turn even if they had the id.
//
// See slices/SLICE_56_FAMILY_REVIEW.md section 3 for the data model.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getPool } from '../../../db/index.js';
import { extractAuthContext } from '../../../mcp-server/auth.js';
import { ok, refused } from '../../employees/mcp-tools/_envelope.js';
import { recordTurnFeedback } from '../../../db/queries/bot-turn-metrics.js';

export function registerBotTurnFeedbackRecord(server: McpServer): void {
  server.tool(
    'bot_turn_feedback_record',
    'Record the user\'s verdict on a bot turn. ' +
    'Scope: caller\'s own tenant only (tenant-scoped UPDATE). ' +
    'Audience: every authenticated user — no permission gate (anyone can give feedback on their own turns). ' +
    'Verdict: positive (👍) | negative (👎). Correction is optional free-text — the user\'s answer to "what should it have done?". ' +
    'Output: { recorded: bool }. recorded=false means the turn id was not found or was on a different tenant — silently no-op. ' +
    'Used by the slash dispatcher when the user taps the verdict buttons on the response-time footer card. ' +
    'Re-running with a new verdict overwrites the prior verdict (e.g., 👎 then later supplying correction text upgrades the row).',
    {
      turn_id:    z.string().regex(/^[0-9a-f]{8}$/),
      verdict:    z.enum(['positive', 'negative']),
      correction: z.string().max(2000).optional(),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {
      requiredPermission: null,
      sideEffectLevel: 'write',
      whenToUse: [
        'User tapped 👍 or 👎 on the response footer card',
        'User submitted a correction via the 👎 follow-up card',
      ],
      whenNotToUse: [
        'Bulk back-fill from outside the turn — use /teach instead for explicit training rows',
      ],
      commonNextTools: [],
      outputSchema: {
        type: 'object', required: ['data'],
        properties: { data: { type: 'object', properties: { recorded: { type: 'boolean' } } } },
      },
    } as any,
    async (args, context) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ctx = extractAuthContext(context.authInfo as any);
      try {
        const recorded = await recordTurnFeedback(getPool(), {
          turnId:     args.turn_id,
          tenantId:   ctx.tenantId,
          verdict:    args.verdict,
          correction: args.correction ?? null,
        });
        return ok({ recorded }, recorded
          ? `Thanks — recorded ${args.verdict === 'positive' ? '👍' : '👎'} on turn ${args.turn_id}.`
          : `Couldn't find turn ${args.turn_id} (it may have rolled out of metrics).`,
        );
      } catch (err) {
        return refused('internal_error', err instanceof Error ? err.message : String(err));
      }
    },
  );
}
