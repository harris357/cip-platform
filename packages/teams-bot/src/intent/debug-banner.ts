// Slice 39B: dev-only classifier debug banner.
// When BOT_DEBUG_CLASSIFICATION=true, the bot posts an additional Teams
// message after every reply showing classifier output, Stage 2 alias
// (if any), and per-stage timing. Off by default.

import type { TurnContext } from '@microsoft/agents-hosting';
import type { Classification } from './classifier.js';

interface DebugInput {
  classification: Classification | null;   // null when classifier failed
  alias:          string | null;           // Stage 2 alias used; null if inline or no-tool
  tool:           string | null;           // tool selected; null if inline or no-tool
  timings:        {
    classify: number;
    route?:   number;
    exec?:    number;
    total:    number;
  };
}

function debugEnabled(): boolean {
  return (process.env['BOT_DEBUG_CLASSIFICATION'] ?? '').toLowerCase() === 'true';
}

function responseTimeEnabled(): boolean {
  // Defaults to ON — small unobtrusive footer with total turn duration. Turn
  // off in prod with BOT_SHOW_RESPONSE_TIME=false.
  return (process.env['BOT_SHOW_RESPONSE_TIME'] ?? 'true').toLowerCase() === 'true';
}

export interface ResponseTimeDetail {
  classifierAlias?: string | null;  // Stage-1 alias (cip-classifier or override)
  routerAlias?:     string | null;  // Stage-2 alias (null on inline / chitchat)
  tool?:            string | null;  // tool name selected by Stage 2
  classifierFell?:  boolean;        // true if classifier failed and we fell back
  // Per-stage timing breakdown — surfaced inline so the user can see where
  // a slow turn spent its budget without enabling the full debug banner.
  category?:        string | null;  // chitchat/meta/hr_admin/...
  classifyMs?:      number;
  routeMs?:         number;
  execMs?:          number;
}

const fmtSeconds = (ms?: number): string => ms === undefined ? '?' : `${(ms / 1000).toFixed(2)}s`;

/**
 * Slice 39B: "_⏱ X.Xs · <pipeline>_" footer sent as a separate Teams activity
 * after every bot reply. Always-on by default; toggle with
 * BOT_SHOW_RESPONSE_TIME=false. Independent of the full classifier debug
 * banner (which carries timings + classification details) — call both, or
 * either, or neither.
 *
 * The pipeline suffix shows category, per-stage timings, and which
 * models/tool ran for this turn. Examples:
 *   "_⏱ 2.98s (classify=1.10s) · meta · cip-classifier_"
 *   "_⏱ 1.53s (classify=0.52s · route=0.95s · exec=0.06s) · hr_admin · cip-classifier → cip-router-fast → list_staff_"
 *   "_⏱ 2.50s (classify=0.40s · route=2.10s) · hr_admin · cip-classifier → cip-router-fast → ∅_"
 *   "_⏱ 4.50s (classify=fail · route=2.10s · exec=2.40s) · reasoning · ∅ → cip-chat → list_staff_"
 */
export async function sendResponseTime(
  context: TurnContext,
  totalMs: number,
  detail?: ResponseTimeDetail,
): Promise<void> {
  if (!responseTimeEnabled()) return;
  const seconds = (totalMs / 1000).toFixed(2);

  // Per-stage timings parenthesised after the total. Only stages that ran
  // get a slot — file-upload turns omit classify/route entirely.
  const timingParts: string[] = [];
  if (detail) {
    if (detail.classifyMs !== undefined) {
      timingParts.push(`classify=${detail.classifierFell ? 'fail' : fmtSeconds(detail.classifyMs)}`);
    }
    if (detail.routeMs !== undefined) timingParts.push(`route=${fmtSeconds(detail.routeMs)}`);
    if (detail.execMs  !== undefined) timingParts.push(`exec=${fmtSeconds(detail.execMs)}`);
  }
  const timings = timingParts.length > 0 ? ` (${timingParts.join(' · ')})` : '';

  const category = detail?.category ? ` · ${detail.category}` : '';

  const pipelineParts: string[] = [];
  if (detail) {
    pipelineParts.push(detail.classifierFell ? '∅' : (detail.classifierAlias ?? '?'));
    if (detail.routerAlias)         pipelineParts.push(detail.routerAlias);
    if (detail.tool)                pipelineParts.push(detail.tool);
    else if (detail.routerAlias)    pipelineParts.push('∅');
  }
  const pipeline = pipelineParts.length > 0 ? ` · ${pipelineParts.join(' → ')}` : '';

  await context.sendActivity(`_⏱ ${seconds}s${timings}${category}${pipeline}_`);
}

export async function maybeSendDebugBanner(
  context: TurnContext,
  input:   DebugInput,
): Promise<void> {
  if (!debugEnabled()) return;

  const { classification, alias, tool, timings } = input;
  const lines: string[] = ['🔍 **classifier debug**'];

  if (classification === null) {
    lines.push('• category: _classifier failed — fell back to legacy single-stage routing_');
  } else {
    lines.push(`• category: \`${classification.category}\` (complexity: \`${classification.complexity}\`)`);
    if (classification.inline_reply) {
      lines.push('• inline_reply: yes — Stage 2 skipped');
    }
  }

  if (alias) lines.push(`• stage 2 alias: \`${alias}\``);
  if (tool)  lines.push(`• tool: \`${tool}\``);

  const t = `classify=${timings.classify}ms` +
            (timings.route !== undefined ? ` route=${timings.route}ms` : '') +
            (timings.exec  !== undefined ? ` exec=${timings.exec}ms`   : '') +
            ` total=${timings.total}ms`;
  lines.push(`• timings: ${t}`);

  await context.sendActivity(lines.join('\n'));
}
