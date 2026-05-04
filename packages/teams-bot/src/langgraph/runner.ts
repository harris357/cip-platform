// Slice 45 + 46b + 48: LangGraph runtime entry point.
//
// Slice 46b: native interrupt() for the write-action confirm gate.
//   1. Read the persisted thread state. If it carries an active
//      interrupt (graph suspended at confirm), invoke with
//      `new Command({ resume: text })` so confirm resumes from where
//      it suspended. Otherwise, invoke with a fresh state seed.
//   2. After invoke, re-read the state. If it's NOW suspended (a fresh
//      turn produced a write that needs confirmation), render the
//      interrupt's `summary` as the user-facing prompt. Otherwise pick
//      the latest AIMessage and send it.
//
// Slice 48: Langfuse `CallbackHandler` wired in via `callbacks: [...]`
// and `bot_turn_metrics` Postgres write. Both best-effort: trace
// upload or DB write failure must not fail the user-visible turn.

import { randomUUID } from 'node:crypto';
import { TurnContext } from '@microsoft/agents-hosting';
import { Activity } from '@microsoft/agents-activity';
import { AIMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';
import { isAIMessage, isToolMessage } from './util/message-types.js';
import { CallbackHandler } from '@langfuse/langchain';
import { buildGraph } from './graph.js';
import { sendResponseTime } from '../intent/debug-banner.js';
import { writeTurnMetric } from './util/turn-metrics.js';
import { getTunables, getTunable } from './tunables.js';
import type { ConfirmInterruptPayload } from './nodes/confirm.js';
import type { BotAuthContext } from '../auth/resolve-context.js';

// Slice 48: process-wide Langfuse callback handler. Langfuse 5.x is
// OTEL-based — the CallbackHandler attaches to whatever OTEL/Langfuse
// SDK is already initialized via env (LANGFUSE_PUBLIC_KEY/SECRET_KEY/
// HOST). If env is missing the handler still constructs cleanly but
// emits no traces. We pass per-handler defaults below; per-invoke
// metadata layered on top via config.metadata.
const langfuseHandler = new CallbackHandler();

/**
 * Short turn identifier for log/footer correlation. 8-char hex slice of
 * a UUID — enough entropy to be unique within a window, short enough to
 * paste back when reporting an issue.
 */
function newTurnId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 8);
}

interface PendingInterrupt {
  payload: ConfirmInterruptPayload;
}

/**
 * Pull the first active interrupt off the graph state, if any.
 * In LangGraph 1.x, interrupts surface as `state.tasks[*].interrupts[*]`
 * after invoke() returns. A non-empty interrupt array means the graph
 * is suspended.
 */
function detectInterrupt(state: { tasks?: unknown }): PendingInterrupt | null {
  const tasks = (state.tasks ?? []) as Array<{ interrupts?: Array<{ value?: unknown }> }>;
  for (const t of tasks) {
    const interrupts = t.interrupts ?? [];
    if (interrupts.length > 0) {
      const value = interrupts[0]?.value;
      if (value && typeof value === 'object' && (value as { kind?: string }).kind === 'write_confirm') {
        return { payload: value as ConfirmInterruptPayload };
      }
    }
  }
  return null;
}

export async function runLangGraph(args: {
  context:  TurnContext;
  ctx:      BotAuthContext;
  threadId: string;
  text:     string;
  tStart:   number;
}): Promise<void> {
  const { context, ctx, threadId, text, tStart } = args;
  const turnId = newTurnId();

  const graph = buildGraph(ctx);

  // Pull persisted state ONCE — used for both interrupt detection AND
  // session-id seeding. Slice 48: ingest mints a new sessionId when the
  // idle gap exceeds lg.session_timeout_minutes; otherwise we keep the
  // existing one. Falls back to threadId on the very first turn.
  const priorState = await graph.getState({ configurable: { thread_id: threadId } });
  const stateValues = (priorState?.values ?? {}) as { sessionId?: string };
  const sessionId = stateValues.sessionId || threadId;

  // Slice 48: callbacks + metadata flow through to Langfuse so a single
  // turn produces ONE trace tree keyed by turnId. Pasting `turn=<id>`
  // from the Teams footer locates the trace; sessions group consecutive
  // turns within a single user interaction.
  const config = {
    configurable: { thread_id: threadId },
    callbacks:    [langfuseHandler],
    metadata: {
      turnId,
      tenantId:   ctx.tenantId,
      employeeId: ctx.employeeId,
      threadId,
      langfuseSessionId: sessionId,
      langfuseUserId:    ctx.employeeId,
    },
    runName: `turn-${turnId}`,
  };

  // Slice 52: streaming mode. bot.ts already sends one typing indicator
  // before the graph runs (Slice 47). For long turns we need to refresh
  // it so Teams doesn't drop the indicator (~10-15s TTL). Per-tenant
  // tunable; default is "typing" (refresh enabled).
  const tunables = await getTunables(ctx.tenantId);
  const mode = getTunable<string>(tunables, 'lg.streaming_mode', 'typing');
  const refreshMs = getTunable<number>(tunables, 'lg.streaming_typing_refresh_ms', 4000);
  let typingInterval: NodeJS.Timeout | null = null;
  if (mode === 'typing') {
    typingInterval = setInterval(() => {
      // Best-effort — typing failures should never bubble. Fire-and-forget.
      context.sendActivity(Activity.fromObject({ type: 'typing' }))
        .catch(err => console.warn(`[streaming] typing refresh failed: ${err instanceof Error ? err.message : String(err)}`));
    }, refreshMs);
  }

  // Step 1: detect a suspended interrupt from a prior turn. If present,
  // this turn is a resume — feed the user's text to confirm via Command.
  const priorInterrupt = detectInterrupt(priorState);

  // Snapshot the persisted message count BEFORE invoke. The checkpointer
  // accumulates messages across turns within a thread, so anything from
  // this index forward in result.messages is THIS turn's contribution.
  // Used by the footer's tools list, refusedTools, and outbound text
  // search — without it, a 4-turn session would show all 4 turns' tools
  // as a "→" chain in every footer.
  const priorMessageCount = ((priorState?.values ?? {}) as { messages?: unknown[] }).messages?.length ?? 0;

  const tInvoke = Date.now();
  let result;
  try {
    result = priorInterrupt
      ? await graph.invoke(new Command({ resume: text }), config)
      : await graph.invoke(
          {
            threadId,
            tenantId:        ctx.tenantId,
            employeeId:      ctx.employeeId,
            permissions:     ctx.permissions,
            roles:           ctx.roles ?? [],
            latestUserText:  text,
            turnId,
            // candidateTools intentionally NOT passed — discover hydrates it.
            // messages — checkpointer carries them across turns.
          },
          config,
        );
  } finally {
    if (typingInterval) clearInterval(typingInterval);
  }
  const tDone = Date.now();

  // Step 2: did THIS invoke produce a new suspension? If yes, render
  // the confirm prompt.
  const postState = await graph.getState(config);
  const newInterrupt = detectInterrupt(postState);
  const confirmationFired = newInterrupt !== null;

  // Slice 56B follow-up: scope all message-derived telemetry + outbound
  // search to THIS TURN's messages, not the entire persisted history.
  const allMessages  = result.messages ?? [];
  const turnMessages = allMessages.slice(priorMessageCount);

  let outbound: string | null = null;
  if (newInterrupt) {
    outbound = `About to: \`${newInterrupt.payload.summary}\`\n\nReply **yes** to confirm or **no** to cancel.`;
  } else {
    // Search ONLY this turn's messages — never echo a prior turn's reply.
    // Slice 56D follow-up: use isAIMessage helper instead of instanceof
    // so deserialized messages from the checkpoint are recognized too.
    for (let i = turnMessages.length - 1; i >= 0; i--) {
      const m = turnMessages[i];
      if (isAIMessage(m) && typeof m.content === 'string' && m.content.trim().length > 0) {
        outbound = m.content;
        break;
      }
    }
  }

  // Slice 55: when respond emitted an adaptive card (e.g., disambiguation),
  // send it as an attachment instead of the plain-text fallback.
  if ((result as { outboundCard?: unknown }).outboundCard) {
    await context.sendActivity(Activity.fromObject({
      type: 'message',
      attachments: [
        { contentType: 'application/vnd.microsoft.card.adaptive', content: (result as { outboundCard: unknown }).outboundCard },
      ],
    }));
  } else if (outbound) {
    await context.sendActivity(outbound);
  } else {
    await context.sendActivity('_(I had nothing to say — try rephrasing?)_');
  }

  // Compact LangGraph footer mirroring the legacy debug-banner format.
  const totalMs = Date.now() - tStart;
  const graphMs = tDone - tInvoke;
  // Per-turn slice — see priorMessageCount above. Without this the footer
  // would show "tool_a → tool_b → tool_c" for an N-turn session even on
  // a single-tool turn.
  const tools  = (turnMessages
    .filter(m => isAIMessage(m) && (m as AIMessage).tool_calls?.length)
    .flatMap(m => (m as AIMessage).tool_calls?.map(tc => tc.name) ?? []));

  // Slice 48: tools_refused — extracted from ToolMessage payloads where
  // the bot's hallucination guard or the tool itself returned a refusal.
  // Slice 56D follow-up: isToolMessage helper instead of instanceof.
  const refusedTools: string[] = [];
  for (const m of turnMessages) {
    if (isToolMessage(m) && typeof m.content === 'string') {
      try {
        const parsed = JSON.parse(m.content) as { refused?: string; name?: string };
        if (parsed.refused && parsed.name) refusedTools.push(parsed.name);
      } catch { /* not JSON, ignore */ }
    }
  }
  const intent = result.triageSignals
    ? (result.triageSignals.needsClarification
       ? 'ask'
       : tools.length > 0
         ? 'tool'
         : 'direct')
    : confirmationFired
      ? 'tool'
      : 'unknown';
  // Compute classifier + grammar layer info BEFORE the footer so it
  // can render "clf=skip:disable_employee(0.91)" / "grammar=verb_disable"
  // as part of the inline debug line.
  const finalState = await graph.getState(config);
  const finalSessionId = ((finalState?.values ?? {}) as { sessionId?: string }).sessionId
                       ?? sessionId;
  const grammarMatch     = ((finalState?.values ?? {}) as { grammarMatch?: { name: string; toolName: string } | null }).grammarMatch ?? null;
  const extractionResult = ((finalState?.values ?? {}) as { extractionResult?: { kind?: string } | null }).extractionResult ?? null;
  const classifierPrediction = ((finalState?.values ?? {}) as {
    classifierPrediction?: { intent: string; confidence: number; classifier_version: string } | null
  }).classifierPrediction ?? null;
  const classifierDecision = ((finalState?.values ?? {}) as { classifierDecision?: string | null }).classifierDecision ?? null;

  await sendResponseTime(context, totalMs, {
    classifierAlias: 'cip-classifier',
    routerAlias:     tools.length > 0 ? 'cip-router-careful' : null,
    tool:            tools[tools.length - 1] ?? null,
    classifierFell:  false,
    intent:          `langgraph:${intent}`,
    routeMs:         graphMs,
    turnId,
    grammarPattern:        grammarMatch?.name ?? null,
    classifierDecision:    classifierDecision ?? null,
    classifierIntent:      classifierPrediction?.intent ?? null,
    classifierConfidence:  classifierPrediction?.confidence ?? null,
    classifierVersion:     classifierPrediction?.classifier_version ?? null,
  });

  // Structured turn log — turn= prefix lets a user paste the ID back
  // and we can grep/locate the exact turn + correlated Langfuse traces.
  const stepCount = result.stepCount ?? 0;
  const triageConfidence = result.triageSignals?.confidence ?? null;
  const clarificationFired = result.triageSignals?.needsClarification ?? false;
  console.log(
    `[turn] turn=${turnId} engine=langgraph tenantId=${ctx.tenantId} threadId=${threadId} ` +
    `intent=${intent} ` +
    `toolsAttempted=[${tools.join(',')}] ` +
    `stepCount=${stepCount} ` +
    `triageConfidence=${triageConfidence ?? 'na'} ` +
    `clarificationFired=${clarificationFired} ` +
    `confirmationFired=${confirmationFired} ` +
    `resumed=${priorInterrupt !== null} ` +
    `grammar=${grammarMatch?.name ?? 'none'} ` +
    `classifier=${classifierDecision ?? 'na'}:${classifierPrediction?.intent ?? '-'}(${classifierPrediction?.confidence?.toFixed(2) ?? '-'}) ` +
    `totalMs=${totalMs} graphMs=${graphMs}`,
  );

  // Slice 46e follow-up: capture the actual Langfuse trace_id (UUID
  // assigned by OTEL when the root span was created) so /turn can
  // produce a direct deep-link instead of a broken search URL. The
  // CallbackHandler exposes this on `last_trace_id` after spans end.
  const langfuseTraceId = (langfuseHandler as unknown as { last_trace_id: string | null }).last_trace_id;

  // Slice 48: best-effort metric write. Failures only log; the [turn]
  // line above is the durable backup if the DB is down.
  // (finalState + grammar/classifier reads happen earlier so the inline
  // footer can include them.)

  void writeTurnMetric({
    turnId,
    tenantId:           ctx.tenantId,
    threadId,
    employeeId:         ctx.employeeId,
    intent,
    toolsAttempted:     tools,
    toolsRefused:       refusedTools,
    stepCount,
    triageConfidence,
    clarificationFired,
    confirmationFired,
    resumed:            priorInterrupt !== null,
    totalMs,
    graphMs,
    langfuseTraceId:    langfuseTraceId ?? null,
    sessionId:          finalSessionId,
    grammarMatched:     grammarMatch !== null,
    grammarPattern:     grammarMatch?.name ?? null,
    extractionOutcome:  extractionResult?.kind ?? null,
    extractionTool:     grammarMatch?.toolName ?? null,
    // Slice 56
    classifierIntent:     classifierPrediction?.intent ?? null,
    classifierConfidence: classifierPrediction?.confidence ?? null,
    classifierVersion:    classifierPrediction?.classifier_version ?? null,
    classifierDecision:   classifierDecision ?? null,
  });
}
