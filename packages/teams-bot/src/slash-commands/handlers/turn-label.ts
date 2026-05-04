// Slice 56K: /turn-label and /turn-label-submit — the "Add to training
// set" flow promised in slice 55, finally implemented.
//
// Two slash commands:
//   /turn-label <turnId>            — fired by the 📚 button on /turn cards
//                                      → fetches turn metrics, renders the
//                                        prefilled label card
//   /turn-label-submit <turnId>     — fired by the prefilled card's Save action
//     text="..." intent=X tool=Y       → INSERTs into bot_intent_training_data
//     next_action=Z                      via bot_intent_training_data_add MCP tool
//
// Both gated on `bot.metrics.read` (same admin gate as /turn and /teach).

import { executeTool } from '../../mcp/tool-executor.js';
import { buildTurnLabelCard } from '../../intent/add-to-training-card.js';
import type { SlashCommandHandlerArgs, SlashCommandResult } from '../registry.js';

const ID_RE = /^[0-9a-f]{8}$/;

// Same hand-mapped tool→intent as import_traces.py. Kept in sync there.
// We don't try to be exhaustive — if a tool isn't in the map, the admin
// types the intent themselves in the card's intent field.
const TOOL_TO_INTENT_HINT: Record<string, string> = {
  employee_disable:         'disable_employee',
  employee_find:            'employee_find',
  employee_list:            'employee_list',
  get_employee_permissions: 'get_employee_permissions',
  get_my_certifications:    'get_my_certifications',
  get_staff_certifications: 'get_staff_certifications',
};

// ─────────────────────────────────────────────────────────────────
// /turn-label <turnId> — open the prefill card
// ─────────────────────────────────────────────────────────────────
export async function turnLabelHandler(args: SlashCommandHandlerArgs): Promise<SlashCommandResult> {
  const after = args.text.trim().slice('/turn-label'.length).trim();
  if (!after || !ID_RE.test(after)) {
    return { reply: '`/turn-label <id>` — fired by the 📚 button on a `/turn <id>` card.' };
  }

  try {
    const result = await executeTool(
      'bot_metrics_get_turn',
      { turn_id: after },
      args.ctx,
    ) as { data?: { intent?: string; tools_attempted?: string[] }; refused?: string; message?: string };

    if (result.refused) {
      return { reply: `Couldn't fetch turn ${after}: ${result.refused}.` };
    }
    if (!result.data) {
      return { reply: `Turn ${after} not found in metrics.` };
    }

    const tool   = result.data.tools_attempted?.[0] ?? '';
    const intent = (tool && TOOL_TO_INTENT_HINT[tool]) || result.data.intent || '';

    return {
      reply: '_Type the user phrasing you want to label, then Save._',
      card:  buildTurnLabelCard({
        turnId: after,
        intent,
        tool:   tool || null,
      }),
    };
  } catch (err) {
    return { reply: `Error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ─────────────────────────────────────────────────────────────────
// /turn-label-submit <turnId> text="..." intent=X tool=Y next_action=Z
// ─────────────────────────────────────────────────────────────────
const ALLOWED_NEXT_ACTIONS = ['call_tool', 'clarify', 'answer_directly', 'unknown'] as const;
type NextAction = typeof ALLOWED_NEXT_ACTIONS[number];

export async function turnLabelSubmitHandler(args: SlashCommandHandlerArgs): Promise<SlashCommandResult> {
  const after = args.text.trim().slice('/turn-label-submit'.length).trim();
  if (!after) {
    return { reply: 'usage: `/turn-label-submit <id> text="..." intent=X tool=Y next_action=Z`' };
  }

  // First whitespace-separated token is the turnId; rest are key=value pairs.
  const firstSpace = after.indexOf(' ');
  if (firstSpace < 0) return { reply: 'Missing turnId or fields.' };
  const turnId = after.slice(0, firstSpace).trim();
  const rest   = after.slice(firstSpace + 1);
  if (!ID_RE.test(turnId)) return { reply: `\`${turnId}\` doesn't look like a turn id.` };

  const parsed = parseKeyValueArgs(rest);
  const text       = parsed['text'] ?? '';
  const intent     = parsed['intent'] ?? '';
  const tool       = parsed['tool'] ?? '';
  const nextAction = parsed['next_action'] ?? 'call_tool';

  if (!text.trim())   return { reply: 'Missing the `text` field — type the user phrasing you want labelled.' };
  if (!intent.trim()) return { reply: 'Missing the `intent` field.' };
  if (!ALLOWED_NEXT_ACTIONS.includes(nextAction as NextAction)) {
    return { reply: `next_action must be one of: ${ALLOWED_NEXT_ACTIONS.join(', ')}.` };
  }

  try {
    const result = await executeTool(
      'bot_intent_training_data_add',
      {
        text, intent,
        ...(tool ? { tool } : {}),
        next_action:    nextAction as NextAction,
        source:         'turn_label',
        source_turn_id: turnId,
      },
      args.ctx,
    ) as { ok?: boolean; data?: { id?: string }; message?: string; code?: string };

    if (result.ok === false) {
      return { reply: `Couldn't save: ${result.message ?? result.code ?? 'unknown error'}.` };
    }
    const idShort = result.data?.id?.slice(0, 8) ?? '?';
    return {
      reply:
        `✓ Saved training row from turn \`${turnId}\` (id=\`${idShort}\`).\n\n` +
        `_Pending review. Run \`make training-data-review\` to inspect._`,
    };
  } catch (err) {
    return { reply: `Error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Tiny key=value parser supporting bare values and double-quoted strings.
 * Same shape as the /teach handler's parser. Extracted here for reuse.
 */
function parseKeyValueArgs(input: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /(\w+)=(?:"([^"]*)"|(\S+))/g;
  let m;
  while ((m = re.exec(input)) !== null) {
    const key = m[1]!;
    const value = m[2] !== undefined ? m[2] : m[3]!;
    out[key] = value;
  }
  return out;
}
