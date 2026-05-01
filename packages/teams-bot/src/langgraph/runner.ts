// Slice 45: LangGraph runtime entry point.
//
// Called from bot.ts when the engine toggle resolves to 'langgraph'.
// Builds a per-request graph (closing over ctx), invokes it with the
// thread_id as the checkpointer key, and sends the resulting AIMessage
// to Teams.

import { randomUUID } from 'node:crypto';
import { TurnContext } from '@microsoft/agents-hosting';
import { AIMessage } from '@langchain/core/messages';
import { buildGraph } from './graph.js';
import { sendResponseTime } from '../intent/debug-banner.js';
import type { BotAuthContext } from '../auth/resolve-context.js';

/**
 * Short turn identifier for log/footer correlation. 8-char hex slice of
 * a UUID — enough entropy to be unique within a window, short enough to
 * paste back when reporting an issue.
 */
function newTurnId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 8);
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

  const tInvoke = Date.now();
  const result = await graph.invoke(
    {
      threadId,
      tenantId:        ctx.tenantId,
      employeeId:      ctx.employeeId,
      permissions:     ctx.permissions,
      roles:           ctx.roles ?? [],
      latestUserText:  text,
      turnId,
      // candidateTools intentionally NOT passed — discover node hydrates
      // it. Same for messages — checkpointer carries them from prior turns.
    },
    { configurable: { thread_id: threadId } },
  );
  const tDone = Date.now();

  // Find the latest AIMessage to send to Teams.
  const messages = result.messages ?? [];
  let outbound: string | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m instanceof AIMessage && typeof m.content === 'string' && m.content.trim().length > 0) {
      outbound = m.content;
      break;
    }
  }

  if (outbound) {
    await context.sendActivity(outbound);
  } else {
    await context.sendActivity('_(I had nothing to say — try rephrasing?)_');
  }

  // Compact LangGraph footer mirroring the legacy debug-banner format.
  const totalMs = Date.now() - tStart;
  const tools  = (messages
    .filter(m => m instanceof AIMessage && m.tool_calls?.length)
    .flatMap(m => (m as AIMessage).tool_calls?.map(tc => tc.name) ?? []));
  const intent = result.triageSignals
    ? (result.triageSignals.needsClarification
       ? 'ask'
       : tools.length > 0
         ? 'tool'
         : 'direct')
    : 'unknown';
  await sendResponseTime(context, totalMs, {
    classifierAlias: 'cip-classifier',
    routerAlias:     tools.length > 0 ? 'cip-router-careful' : null,
    tool:            tools[tools.length - 1] ?? null,
    classifierFell:  false,
    intent:          `langgraph:${intent}`,
    routeMs:         tDone - tInvoke,
    turnId,
  });

  // Structured turn log — turn= prefix lets a user paste the ID back
  // and we can grep/locate the exact turn + correlated Langfuse traces.
  console.log(
    `[turn] turn=${turnId} engine=langgraph tenantId=${ctx.tenantId} threadId=${threadId} ` +
    `intent=${intent} ` +
    `toolsAttempted=[${tools.join(',')}] ` +
    `stepCount=${result.stepCount ?? 0} ` +
    `triageConfidence=${result.triageSignals?.confidence ?? 'na'} ` +
    `clarificationFired=${result.triageSignals?.needsClarification ?? false} ` +
    `confirmationFired=${result.pendingWriteCall ? true : false} ` +
    `totalMs=${totalMs} graphMs=${tDone - tInvoke}`,
  );
}
