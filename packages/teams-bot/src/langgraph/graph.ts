// Slice 45: graph composition.
//
// Each call to buildGraph() produces a freshly-compiled StateGraph with
// node closures bound to the current BotAuthContext. We don't try to
// share a single graph across requests because:
//   1. ctx (auth, virtual key, bearer token) varies per request.
//   2. Compilation is cheap (~ms).
//
// The compiled graph uses our shared `checkpointer` (MemorySaver) so
// per-thread state IS shared across turns within the pod's lifetime.

import { StateGraph, START, END } from '@langchain/langgraph';
import { StateAnnotation, type State } from './state.js';
import { checkpointer } from './checkpointer.js';
import { ingestNode } from './nodes/ingest.js';
import { makeDiscoverCandidatesNode } from './nodes/discover.js';
import { makeTriageNode } from './nodes/triage.js';
import { makePlanNode } from './nodes/plan.js';
import { gateWriteActionNode, routeAfterGate } from './nodes/gate-write.js';
import { confirmNode } from './nodes/confirm.js';
import { makeExecuteToolNode } from './nodes/execute.js';
import { respondNode } from './nodes/respond.js';
import { makeSummarizeNode, shouldSummarize } from './nodes/summarize.js';
import { getTunables, getTunable } from './tunables.js';
import { AIMessage } from '@langchain/core/messages';
import type { BotAuthContext } from '../auth/resolve-context.js';

/**
 * Conditional edge after confirm — Slice 46b:
 *   - With native interrupt(), confirm resumes inside the node when the
 *     user replies. On affirm, confirm emits an AIMessage with tool_calls
 *     for the saved write — route to execute.
 *   - On cancel or unrecognized, confirm emits a text-only AIMessage —
 *     route to END.
 */
function routeAfterConfirm(state: State): 'execute' | 'end' {
  const last = state.messages[state.messages.length - 1];
  if (last instanceof AIMessage && last.tool_calls && last.tool_calls.length > 0) {
    return 'execute';
  }
  return 'end';
}

/**
 * Conditional edge after triage:
 *   - needsClarification at confidence ≥ threshold → respond directly
 *   - otherwise → plan
 *
 * Tunable: lg.triage_clarify_threshold (default 0.7).
 * NOTE: this is async to read tunables. LangGraph supports async
 * conditional edges since 0.2.
 */
async function routeOnSignals(state: State): Promise<'respond' | 'plan'> {
  const tunables = await getTunables(state.tenantId);
  const threshold = getTunable<number>(tunables, 'lg.triage_clarify_threshold', 0.7);
  if (
    state.triageSignals?.needsClarification &&
    state.triageSignals.confidence >= threshold &&
    state.triageSignals.clarificationQuestion
  ) {
    return 'respond';
  }
  return 'plan';
}

/**
 * Conditional edge after executeTool:
 *   - stepCount ≥ MAX_STEPS → respond
 *   - otherwise            → plan (loop)
 */
async function shouldContinue(state: State): Promise<'plan' | 'respond'> {
  const tunables = await getTunables(state.tenantId);
  const maxSteps = getTunable<number>(tunables, 'lg.max_steps', 5);
  if (state.stepCount >= maxSteps) return 'respond';
  return 'plan';
}

export function buildGraph(ctx: BotAuthContext) {
  const graph = new StateGraph(StateAnnotation)
    .addNode('ingest',     ingestNode)
    .addNode('discover',   makeDiscoverCandidatesNode(ctx))
    .addNode('triage',     makeTriageNode(ctx))
    .addNode('plan',       makePlanNode(ctx))
    .addNode('gateWrite',  gateWriteActionNode)
    .addNode('confirm',    confirmNode)
    .addNode('execute',    makeExecuteToolNode(ctx))
    .addNode('respond',    respondNode)
    .addNode('summarize',  makeSummarizeNode(ctx))

    .addEdge(START, 'ingest')
    .addEdge('ingest', 'discover')
    .addEdge('discover', 'triage')
    .addConditionalEdges('triage', routeOnSignals, {
      respond: 'respond',
      plan:    'plan',
    })
    .addEdge('plan', 'gateWrite')
    .addConditionalEdges('gateWrite', routeAfterGate, {
      confirm: 'confirm',
      execute: 'execute',
      respond: 'respond',
    })
    .addConditionalEdges('execute', shouldContinue, {
      plan:    'plan',
      respond: 'respond',
    })
    .addConditionalEdges('confirm', routeAfterConfirm, {
      execute: 'execute',
      end:     END,
    })
    .addConditionalEdges('respond', shouldSummarize, {
      summarize: 'summarize',
      end:       END,
    })
    .addEdge('summarize', END);

  return graph.compile({
    checkpointer,
    // Slice 46b: confirmNode calls interrupt() to suspend at the confirm
    // gate. The checkpoint captures the suspension point automatically.
    // runner detects the suspension via getState().tasks[*].interrupts
    // and resumes with `new Command({ resume: userText })` on the next
    // user message — execution continues from inside confirmNode where
    // it suspended.
  });
}
