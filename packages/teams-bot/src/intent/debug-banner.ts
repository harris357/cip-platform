// Slice 39B → Slice 47b: response-time footer used by the LangGraph
// runtime. The legacy debug-banner (maybeSendDebugBanner +
// BOT_DEBUG_CLASSIFICATION env flag) was deleted alongside the legacy
// classifier+router pipeline.

import type { TurnContext } from '@microsoft/agents-hosting';

function responseTimeEnabled(): boolean {
  // Defaults to ON — small unobtrusive footer with total turn duration. Turn
  // off in prod with BOT_SHOW_RESPONSE_TIME=false.
  return (process.env['BOT_SHOW_RESPONSE_TIME'] ?? 'true').toLowerCase() === 'true';
}

export interface ResponseTimeDetail {
  classifierAlias?: string | null;  // Stage-1 alias (cip-classifier or override)
  routerAlias?:     string | null;  // Router or meta_compose alias; null on chitchat
  tool?:            string | null;  // tool name selected by router (proceed path only)
  classifierFell?:  boolean;        // true if classifier failed and we fell back to proceed
  // Per-stage timing breakdown — surfaced inline so the user can see where
  // a slow turn spent its budget without enabling the full debug banner.
  intent?:          string | null;  // chitchat | meta | proceed (Slice 43)
  classifyMs?:      number;
  routeMs?:         number;
  execMs?:          number;
  /** Slice 47c: per-turn correlation ID. Surfaced in footer so users can paste
   *  it back when reporting an issue; we then grep [turn] log lines for
   *  `turn=<id>` and find correlated Langfuse traces by the same trace_id. */
  turnId?:          string;
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

  const intent = detail?.intent ? ` · ${detail.intent}` : '';

  const pipelineParts: string[] = [];
  if (detail) {
    pipelineParts.push(detail.classifierFell ? '∅' : (detail.classifierAlias ?? '?'));
    if (detail.routerAlias)         pipelineParts.push(detail.routerAlias);
    if (detail.tool)                pipelineParts.push(detail.tool);
    else if (detail.routerAlias)    pipelineParts.push('∅');
  }
  const pipeline = pipelineParts.length > 0 ? ` · ${pipelineParts.join(' → ')}` : '';

  const turn = detail?.turnId ? ` · turn=\`${detail.turnId}\`` : '';

  await context.sendActivity(`_⏱ ${seconds}s${timings}${intent}${pipeline}${turn}_`);
}

