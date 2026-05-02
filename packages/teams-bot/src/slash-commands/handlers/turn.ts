// Slice 46e: /turn <id> slash command. Calls the bot_metrics_get_turn
// MCP tool and renders the result as a markdown card.
//
// Wired via the existing slash-command dispatcher (registry.ts + dispatch.ts).
// The text after `/turn ` is parsed as the turn_id; if missing or malformed,
// returns a usage hint without touching the MCP server.
//
// Permission gate: the handler bounces if the caller doesn't have
// `bot.metrics.read`. Same gate as the underlying MCP tool — single
// source of truth is registry.ts entry below.

import { executeTool } from '../../mcp/tool-executor.js';
import type { SlashCommandHandlerArgs, SlashCommandResult } from '../registry.js';

const ID_RE = /^[0-9a-f]{8}$/;

export async function turnHandler(args: SlashCommandHandlerArgs): Promise<SlashCommandResult> {
  const after = args.text.trim().slice('/turn'.length).trim();
  if (!after) {
    return {
      reply:
        '`/turn <id>` — pass an 8-char turn id from a response footer. Example: `/turn 592edfbe`',
    };
  }
  if (!ID_RE.test(after)) {
    return {
      reply:
        `\`${after}\` doesn't look like a turn id (expected 8 hex chars). Copy the value after \`turn=\` from a footer.`,
    };
  }

  try {
    const result = await executeTool(
      'bot_metrics_get_turn',
      { turn_id: after },
      args.ctx,
    ) as { data?: Record<string, unknown>; refused?: string; message?: string };

    if (result.refused) {
      return { reply: `Couldn't fetch turn ${after}: ${result.refused}.` };
    }
    if (!result.data) {
      return { reply: `Turn ${after} not found.` };
    }
    return { reply: renderTurnCard(after, result.data) };
  } catch (err) {
    return {
      reply: `Error fetching turn ${after}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function fmtCostUsd(v: unknown): string | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  // Plain decimal USD with enough precision for sub-cent values.
  // Langfuse returns up to ~9-decimal precision; we cap at 6dp for
  // small values so a $0.000541 cost reads as "$0.000541" not
  // "$0.000541123…". Larger values use 4dp like a normal currency.
  if (v === 0)     return '$0';
  if (v < 0.01)    return `$${v.toFixed(6)}`;
  return `$${v.toFixed(4)}`;
}

function renderTurnCard(turnId: string, row: Record<string, unknown>): string {
  const intent       = String(row['intent'] ?? '?');
  const totalMs      = Number(row['total_ms'] ?? 0);
  const graphMs      = Number(row['graph_ms'] ?? 0);
  const stepCount    = Number(row['step_count'] ?? 0);
  const triageConf   = row['triage_confidence'];
  const tools        = Array.isArray(row['tools_attempted']) ? row['tools_attempted'] as string[] : [];
  const refused      = Array.isArray(row['tools_refused'])   ? row['tools_refused']   as string[] : [];
  const clarification = !!row['clarification_fired'];
  const confirmation  = !!row['confirmation_fired'];
  const resumed       = !!row['resumed'];
  const emittedAt     = String(row['emitted_at'] ?? '');
  const traceUrl      = row['trace_url']   ? String(row['trace_url'])   : null;
  const sessionUrl    = row['session_url'] ? String(row['session_url']) : null;
  const traceMeta     = row['langfuse_trace']   as { totalCost?: number | null; latency?: number | null } | null;
  const sessionMeta   = row['langfuse_session'] as { totalCost?: number | null; traceCount?: number }     | null;

  const lines: string[] = [];
  lines.push(`### Turn \`${turnId}\``);
  lines.push(`_${emittedAt}_`);
  lines.push('');
  lines.push(`**${intent}** · ${(totalMs / 1000).toFixed(2)}s total · ${(graphMs / 1000).toFixed(2)}s in graph · steps=${stepCount}`);
  if (typeof triageConf === 'number') {
    lines.push(`Triage confidence: ${triageConf.toFixed(2)}`);
  }
  if (tools.length > 0) {
    lines.push(`Tools: \`${tools.join('` → `')}\``);
  }
  if (refused.length > 0) {
    lines.push(`⚠ Refused: \`${refused.join('`, `')}\``);
  }
  const flags: string[] = [];
  if (clarification) flags.push('clarification');
  if (confirmation)  flags.push('confirmation');
  if (resumed)       flags.push('resumed');
  if (flags.length > 0) {
    lines.push(`Flags: ${flags.join(', ')}`);
  }

  // Langfuse-derived lines. Latency is always available once the trace
  // is ingested; cost only when Langfuse has finished its async cost
  // computation AND has pricing for the model. Render both
  // independently so the user sees SOMETHING even when cost is pending
  // or the model isn't in Langfuse's price registry.
  if (traceMeta) {
    const parts: string[] = [];
    if (typeof traceMeta.latency === 'number') {
      parts.push(`${traceMeta.latency.toFixed(2)}s`);
    }
    const cost = fmtCostUsd(traceMeta.totalCost);
    if (cost !== null) parts.push(cost);
    if (parts.length > 0) lines.push(`Langfuse trace: ${parts.join(' · ')}`);
  }
  if (sessionMeta) {
    const sessionCost = fmtCostUsd(sessionMeta.totalCost);
    const tc          = typeof sessionMeta.traceCount === 'number' ? sessionMeta.traceCount : null;
    const parts: string[] = [];
    if (tc !== null)          parts.push(`${tc} turn${tc === 1 ? '' : 's'}`);
    if (sessionCost !== null) parts.push(sessionCost);
    if (parts.length > 0) lines.push(`Session: ${parts.join(' · ')}`);
  }

  if (traceUrl || sessionUrl) {
    lines.push('');
    const links: string[] = [];
    if (traceUrl)   links.push(`[Open Trace](${traceUrl})`);
    if (sessionUrl) links.push(`[Open Session](${sessionUrl})`);
    lines.push(links.join(' · '));
  }
  return lines.join('\n');
}
