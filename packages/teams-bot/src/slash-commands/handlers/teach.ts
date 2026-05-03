// Slice 55: /teach <key=value> ... text="..." — append a labelled
// training example for the sklearn classifier (Slice 56).
//
// Usage:
//   /teach intent=disable_employee tool=employee_disable next_action=call_tool text="off-board the contractor"
//   /teach intent=view_certs next_action=clarify text="what about her certs"
//
// Requires `bot.metrics.read` (same gate as /turn). Writes via the
// bot_intent_example_add MCP tool, which lands the row in
// bot_intent_examples with reviewed=false. Operator must run
// `make training-data-mark-reviewed ids=<id>` to promote into training
// data (or `make training-data-export` aggregates reviewed rows
// alongside the manual_examples.csv file).

import { executeTool } from '../../mcp/tool-executor.js';
import type { SlashCommandHandlerArgs, SlashCommandResult } from '../registry.js';

const ALLOWED_NEXT_ACTIONS = ['call_tool', 'clarify', 'answer_directly', 'unknown'] as const;
type NextAction = typeof ALLOWED_NEXT_ACTIONS[number];

export async function teachHandler(args: SlashCommandHandlerArgs): Promise<SlashCommandResult> {
  const after = args.text.trim().slice('/teach'.length).trim();
  if (!after) return { reply: usage() };

  let parsed: Record<string, string>;
  try {
    parsed = parseKeyValueArgs(after);
  } catch (err) {
    return { reply: `Couldn't parse: ${err instanceof Error ? err.message : String(err)}\n\n${usage()}` };
  }

  const text       = parsed['text'];
  const intent     = parsed['intent'];
  const nextAction = parsed['next_action'];
  const tool       = parsed['tool'];
  const notes      = parsed['notes'];

  if (!text)       return { reply: `Missing required \`text="..."\`. ${usage()}` };
  if (!intent)     return { reply: `Missing required \`intent=...\`. ${usage()}` };
  if (!nextAction) return { reply: `Missing required \`next_action=...\`. Allowed: ${ALLOWED_NEXT_ACTIONS.join(', ')}.` };
  if (!ALLOWED_NEXT_ACTIONS.includes(nextAction as NextAction)) {
    return { reply: `next_action must be one of: ${ALLOWED_NEXT_ACTIONS.join(', ')}.` };
  }

  try {
    const result = await executeTool(
      'bot_intent_example_add',
      {
        text, intent,
        ...(tool ? { tool } : {}),
        next_action: nextAction as NextAction,
        source:      'teach',
        ...(notes ? { notes } : {}),
      },
      args.ctx,
    ) as { ok?: boolean; data?: { id?: string }; message?: string; code?: string };

    if (result.ok === false) {
      return { reply: `Couldn't save: ${result.message ?? result.code ?? 'unknown error'}.` };
    }
    const idShort = result.data?.id?.slice(0, 8) ?? '?';
    return {
      reply:
        `✓ Saved training example (id=\`${idShort}\`).\n\n` +
        `Pending review. Run \`make training-data-review\` to inspect, then ` +
        `\`make training-data-mark-reviewed ids='${result.data?.id ?? '?'}'\` to promote.`,
    };
  } catch (err) {
    return { reply: `Error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function usage(): string {
  return [
    '`/teach <key=value>... text="..."` — label a training example.',
    '',
    '**Required:** `intent=`, `next_action=`, `text="..."`',
    '**Optional:** `tool=`, `notes="..."`',
    '',
    'Example:',
    '`/teach intent=disable_employee tool=employee_disable next_action=call_tool text="off-board the contractor"`',
  ].join('\n');
}

/**
 * Tiny key=value parser supporting bare values and double-quoted strings.
 *   intent=foo tool=bar text="hello world" notes="multi word"
 */
function parseKeyValueArgs(input: string): Record<string, string> {
  const out: Record<string, string> = {};
  // Match key=value where value is either "double-quoted" or bare (no spaces).
  const re = /(\w+)=(?:"([^"]*)"|(\S+))/g;
  let m;
  while ((m = re.exec(input)) !== null) {
    const key = m[1]!;
    const value = m[2] !== undefined ? m[2] : m[3]!;
    out[key] = value;
  }
  if (Object.keys(out).length === 0) {
    throw new Error('no key=value pairs detected');
  }
  return out;
}
