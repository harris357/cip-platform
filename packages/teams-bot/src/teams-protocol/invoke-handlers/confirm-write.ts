// Slice 53 — confirm-write invoke handler.
//
// Verb: `bot.write_confirm.respond`. Wired into the router by
// `index.ts` at boot. The router has already done:
//   - parsed `verb` + `data` out of the activity
//   - run the `authorizedUser` hook → bounced any wrong-user click
//
// What this handler does on a click:
//   1. TTL check  — `proposedAt` against `lg.confirm_card_ttl_seconds`.
//   2. Suspended-state check — re-read the graph state. If the graph
//      is no longer suspended at confirm (user already replied "yes"
//      via text, or someone else's prior click resumed it), return an
//      "Already handled" replacement card with statusCode 200 so Teams
//      stops retrying.
//   3. Permission re-check — re-fetch the user's permissions and
//      assert the proposed tool's `requiredPermission`. UX hardening
//      on top of the server-side `assertPermission` that fires inside
//      the tool. Refusal here returns a "Not authorised" card.
//   4. Resume the graph with `Command({ resume: { decision } })`.
//      Confirm node's `classifyConfirmReply` accepts the structured
//      object (see slice 53 changes to that util).
//   5. Build the post-resolution result card and return it as the
//      `AdaptiveCardInvokeResponse` body. Teams replaces the original
//      card in place.
//   6. Send the resulting AIMessage as a follow-up `sendActivity`
//      (mirrors `runner.ts` post-turn behaviour for normal text turns).
//
// Idempotency: step 2 is the gate. Teams retries `Action.Execute` if
// it doesn't see a 200 within ~10 s. The second invoke finds the
// graph already advanced, returns "Already handled" with status 200,
// retries stop.

import type { TurnContext } from '@microsoft/agents-hosting';
import { Command } from '@langchain/langgraph';
import { AIMessage } from '@langchain/core/messages';
import { Activity } from '@microsoft/agents-activity';
import type { Tool as McpTool } from '@modelcontextprotocol/sdk/types.js';

import {
  CONFIRM_VERB,
  buildResultCard,
  type ResultDecision,
} from '../cards/confirm.js';
import type { InvokeContext, InvokeHandler, InvokeResult } from '../invoke-router.js';
import { resolveTenantContext } from '../../auth/tenant-resolver.js';
import { getCachedToken } from '../../auth/token-store.js';
import { resolveAuthContext } from '../../auth/resolve-context.js';
import { buildGraph } from '../../langgraph/graph.js';
import { getTunables, getTunable } from '../../langgraph/tunables.js';
import { discoverTools } from '../../mcp/tool-discovery.js';
import { isAIMessage } from '../../langgraph/util/message-types.js';

const CARD_CONTENT_TYPE = 'application/vnd.microsoft.card.adaptive';

interface ParsedClick {
  turnId:     string;
  threadId:   string;
  decision:   'confirm' | 'cancel';
  proposedAt: number;
}

function parseClick(data: Record<string, unknown>): ParsedClick | null {
  const turnId     = typeof data['turnId']   === 'string' ? data['turnId']   as string : null;
  const threadId   = typeof data['threadId'] === 'string' ? data['threadId'] as string : null;
  const decision   = data['decision'];
  const proposedAt = typeof data['proposedAt'] === 'number' ? data['proposedAt'] as number : null;
  if (!turnId || !threadId || !proposedAt) return null;
  if (decision !== 'confirm' && decision !== 'cancel') return null;
  return { turnId, threadId, decision, proposedAt };
}

/**
 * Build an AdaptiveCardInvokeResponse body that replaces the original
 * card with `card`. Status code is always 200 so Teams stops retrying;
 * business-logic refusals are surfaced by the result card content,
 * not by HTTP status.
 */
function cardReplacementResult(decision: ResultDecision, summary: string): InvokeResult {
  const card = buildResultCard(decision, summary);
  return {
    statusCode: 200,
    body: {
      statusCode: 200,
      type:  CARD_CONTENT_TYPE,
      value: card,
    },
  };
}

/**
 * Pull the active confirm interrupt off the graph state, if any. Same
 * shape as `runner.detectInterrupt` — we re-implement here rather than
 * import to keep this module self-contained (handler boots from
 * index.ts, runner imports are sub-cycle-safe).
 */
interface PendingConfirm {
  payload: {
    kind:       'write_confirm';
    summary:    string;
    toolName:   string;
    toolArgs:   Record<string, unknown>;
    toolCallId: string;
    turnId?:    string;
    proposedAt?: number;
  };
}
function detectConfirmInterrupt(state: { tasks?: unknown }): PendingConfirm | null {
  const tasks = (state.tasks ?? []) as Array<{ interrupts?: Array<{ value?: unknown }> }>;
  for (const t of tasks) {
    const interrupts = t.interrupts ?? [];
    if (interrupts.length > 0) {
      const value = interrupts[0]?.value;
      if (value && typeof value === 'object' && (value as { kind?: string }).kind === 'write_confirm') {
        return { payload: value as PendingConfirm['payload'] };
      }
    }
  }
  return null;
}

async function readSuspendedEmployeeAad(threadId: string, builderJwt: string): Promise<string | undefined> {
  // The suspended state has `state.values.employeeId` populated by the
  // first turn's ingest (employeeId == aadObjectId — see
  // resolve-context.ts). Building the graph requires an auth context;
  // we use a minimal proxy ctx for read-only state inspection.
  // NOTE: `buildGraph` is parameterised by ctx for node-binding only;
  // `getState` doesn't run nodes. A throwaway ctx is fine.
  const proxyCtx = {
    tenantId:    '',
    userId:      '',
    employeeId:  '',
    permissions: {} as Record<string, boolean>,
    roles:       [] as string[],
    bearerToken: builderJwt,
    tenantConfig: {
      tenantId:          '',
      name:              '',
      litellmVirtualKey: process.env['LITELLM_VIRTUAL_KEY'] ?? '',
      keycloakRealm:     '',
      natsPrefix:        '',
      langfuseTags:      {},
    },
  };
  const graph = buildGraph(proxyCtx);
  const persisted = await graph.getState({ configurable: { thread_id: threadId } });
  const values = (persisted?.values ?? {}) as { employeeId?: string };
  return values.employeeId || undefined;
}

/**
 * Re-check the proposed tool's `requiredPermission` against the
 * clicker. Returns true if the click is permitted; false otherwise.
 * Conservative on lookup failure — refuse on any error rather than
 * letting a stale or partial catalog open the gate.
 */
async function permissionAllowsClick(
  toolName:    string,
  ctx:         { tenantId: string; employeeId: string; permissions: Record<string, boolean>; bearerToken: string },
): Promise<boolean> {
  let tools: McpTool[];
  try {
    // discoverTools uses the bot-side auth context; passing the click's
    // user means we get THEIR catalog (with their permissions filter).
    // BotAuthContext interface in resolve-context.ts pulls in everything
    // we need for the cache key; the proxy here matches the shape.
    tools = await discoverTools({
      ...ctx,
      userId:  ctx.employeeId,
      roles:   [],
      tenantConfig: {
        tenantId:          ctx.tenantId,
        name:              ctx.tenantId,
        litellmVirtualKey: process.env['LITELLM_VIRTUAL_KEY'] ?? '',
        keycloakRealm:     '',
        natsPrefix:        `cip.${ctx.tenantId}`,
        langfuseTags:      {},
      },
    });
  } catch (err) {
    console.warn(`[confirm-write] discoverTools failed during permission re-check: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
  const tool = tools.find(t => t.name === toolName);
  if (!tool) {
    // The tool isn't in the user's filtered catalog → they can't see it,
    // they can't run it. Refuse.
    return false;
  }
  const required = (tool.annotations as Record<string, unknown> | undefined)?.['requiredPermission'];
  if (required === undefined || required === null || required === '') return true;
  if (typeof required !== 'string') return true;
  return ctx.permissions[required] === true;
}

/**
 * Handler implementation. Exported as `confirmWriteHandler` so
 * `index.ts` can register it at boot.
 */
export const confirmWriteHandler: InvokeHandler = {
  verb: CONFIRM_VERB,

  authorizedUser: async (ctx: InvokeContext) => {
    const click = parseClick(ctx.data);
    if (!click) return undefined;   // malformed → router skips check; handler will refuse
    const tenantCtxOrErr = await resolveTenantContext(getAadTenantId(ctx.context));
    if ('error' in tenantCtxOrErr) return undefined;
    const userId = ctx.context.activity.from?.id ?? '';
    const jwt = getCachedToken(userId);
    if (!jwt) return undefined;
    try {
      return await readSuspendedEmployeeAad(click.threadId, jwt);
    } catch (err) {
      console.warn(`[confirm-write] authorizedUser introspection failed: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  },

  async handle(ctx: InvokeContext): Promise<InvokeResult> {
    const click = parseClick(ctx.data);
    if (!click) {
      console.warn(`[confirm-write] malformed click data: ${JSON.stringify(ctx.data)}`);
      return cardReplacementResult('already_handled', 'Confirmation data missing or invalid.');
    }

    // ─── Step 1: TTL ────────────────────────────────────────────────
    const aadTenantId = getAadTenantId(ctx.context);
    const tenantCtxOrErr = await resolveTenantContext(aadTenantId);
    if ('error' in tenantCtxOrErr) {
      console.warn(`[confirm-write] tenant resolution failed: ${tenantCtxOrErr.error} aadTenantId="${aadTenantId}"`);
      return cardReplacementResult('already_handled', 'Tenant context unavailable.');
    }
    const tenantCtx = tenantCtxOrErr;

    const tunables = await getTunables(tenantCtx.cipTenantId);
    const ttlSeconds = getTunable<number>(tunables, 'lg.confirm_card_ttl_seconds', 600);
    if (Date.now() - click.proposedAt > ttlSeconds * 1000) {
      return cardReplacementResult('expired', '');
    }

    // ─── Auth context (need it for graph build + permission re-check) ─
    const userId = ctx.context.activity.from?.id ?? '';
    const keycloakJwt = getCachedToken(userId);
    if (!keycloakJwt) {
      // No cached token — this clicker is unknown to us. Don't try to
      // bootstrap SSO from an invoke (would lose the click). Refuse.
      console.warn(`[confirm-write] no cached JWT for clicker userId=${userId}`);
      return cardReplacementResult('permission_denied', '');
    }

    let authCtx;
    try {
      authCtx = await resolveAuthContext(ctx.context, tenantCtx, keycloakJwt);
    } catch (err) {
      console.warn(`[confirm-write] resolveAuthContext failed: ${err instanceof Error ? err.message : String(err)}`);
      return cardReplacementResult('permission_denied', '');
    }

    // ─── Step 2: still suspended? ────────────────────────────────────
    const graph = buildGraph(authCtx);
    const persisted = await graph.getState({ configurable: { thread_id: click.threadId } });
    const interrupt = detectConfirmInterrupt(persisted);
    if (!interrupt) {
      return cardReplacementResult('already_handled', '');
    }
    const summary = interrupt.payload.summary;

    // ─── Step 3: permission re-check (only on confirm; cancel always OK) ─
    if (click.decision === 'confirm') {
      const allowed = await permissionAllowsClick(interrupt.payload.toolName, authCtx);
      if (!allowed) {
        return cardReplacementResult('permission_denied', summary);
      }
    }

    // ─── Step 4: resume ──────────────────────────────────────────────
    let resumed;
    try {
      resumed = await graph.invoke(
        new Command({ resume: { decision: click.decision } }),
        { configurable: { thread_id: click.threadId } },
      );
    } catch (err) {
      console.warn(`[confirm-write] graph.invoke threw on resume: ${err instanceof Error ? err.message : String(err)}`);
      // The graph errored — return "already handled" rather than the
      // wrong verdict. The user can re-issue the request. Server-side
      // tool execution may have partially completed; that's a separate
      // diagnostic path.
      return cardReplacementResult('already_handled', summary);
    }

    // ─── Step 5: build the result card ───────────────────────────────
    const verdict: ResultDecision = click.decision === 'confirm' ? 'confirmed' : 'cancelled';
    const result = cardReplacementResult(verdict, summary);

    // ─── Step 6: send the resulting AIMessage as a follow-up ─────────
    // Same selection rule as runner.ts: latest non-empty AIMessage in
    // this turn's slice. We don't have priorMessageCount here so we
    // walk back from the tail until we hit one with content.
    const messages = (resumed?.messages ?? []) as Array<{ content?: unknown }>;
    let outbound: string | null = null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (!m) continue;
      if (isAIMessage(m as AIMessage) && typeof m.content === 'string' && m.content.trim().length > 0) {
        outbound = m.content;
        break;
      }
    }
    if (outbound) {
      try {
        await ctx.context.sendActivity(Activity.fromObject({ type: 'message', text: outbound }));
      } catch (err) {
        // Best-effort. The card replacement already conveys the verdict;
        // a missing follow-up is an annoyance, not a failure.
        console.warn(`[confirm-write] follow-up sendActivity failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return result;
  },
};

function getAadTenantId(context: TurnContext): string {
  return (context.activity.channelData as { tenant?: { id?: string } } | undefined)?.tenant?.id ?? '';
}
