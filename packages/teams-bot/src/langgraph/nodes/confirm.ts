// Slice 46b: native interrupt() confirm node.
//
// Replaces the hand-rolled pattern (set pendingWriteCall → END → ingest
// classifies the resume reply) with LangGraph 1.x's first-class
// interrupt() + Command({resume: ...}). Three things changed:
//
//   1. The graph SUSPENDS at interrupt() instead of returning. The
//      checkpoint captures the suspension point automatically; runner
//      detects it by reading getState(config).tasks.
//   2. Affirm/cancel classification lives in this node — moved out of
//      ingest where it didn't belong.
//   3. The runner resumes with `new Command({ resume: userText })`,
//      which makes interrupt() return userText. Execution continues
//      INSIDE confirm from the line after interrupt().
//
// On affirm: emit AIMessage(tool_calls) so the conditional edge
// `routeAfterConfirm` sends the graph to `execute`.
// On cancel: emit a "Cancelled." AIMessage; routeAfterConfirm sends
// to END.
// On unrecognized: emit a clarifying AIMessage and END — safer than
// guessing. The user can re-state on the next turn.

import { interrupt } from '@langchain/langgraph';
import { AIMessage } from '@langchain/core/messages';
import { getTunables, getTunable } from '../tunables.js';
import { classifyConfirmReply } from '../util/classify-confirm-reply.js';
import type { State } from '../state.js';

export interface ConfirmInterruptPayload {
  kind:       'write_confirm';
  summary:    string;
  toolName:   string;
  toolArgs:   Record<string, unknown>;
  toolCallId: string;
}

export async function confirmNode(state: State): Promise<Partial<State>> {
  if (!state.pendingWriteCall) {
    // Defensive: somehow we routed to confirm with no pending. Drop
    // through cleanly — graph will hit the conditional edge and END.
    return {};
  }

  const payload: ConfirmInterruptPayload = {
    kind:       'write_confirm',
    summary:    state.pendingWriteCall.summary,
    toolName:   state.pendingWriteCall.toolName,
    toolArgs:   state.pendingWriteCall.toolArgs,
    toolCallId: state.pendingWriteCall.toolCallId,
  };

  // SUSPEND. The checkpoint captures this point. On resume,
  // `decision` is whatever string the runner passed to Command({resume}).
  const decision = interrupt<ConfirmInterruptPayload, string>(payload);

  const tunables = await getTunables(state.tenantId);
  const affirm = getTunable<string[]>(tunables, 'lg.affirmation_patterns',
    ['yes', 'y', 'confirm', 'go ahead', 'do it', 'ok', 'okay', 'sure']);
  const cancel = getTunable<string[]>(tunables, 'lg.cancellation_patterns',
    ['no', 'n', 'cancel', 'stop', 'never mind', 'nevermind', 'wait']);

  const verdict = classifyConfirmReply(decision, affirm, cancel);

  if (verdict === 'affirm') {
    // Slice 56D follow-up: do NOT re-emit a new AIMessage(tool_calls)
    // here. The planner's original AIMessage with these exact tool_calls
    // is still the last message in state (the interrupt suspended INSIDE
    // this node — nothing was appended in between). Just clear the
    // pending flag; routeAfterConfirm sees the original AIMessage and
    // routes to execute, execute reads it and runs the tool.
    //
    // Why this matters: re-emitting created a SECOND AIMessage with the
    // same tool_call_id as the planner's original. On subsequent turns,
    // the planner LLM was sent both → Mistral 400 "Duplicate tool call
    // id in assistant message" → the entire turn errored out.
    return { pendingWriteCall: null };
  }

  if (verdict === 'cancel') {
    return {
      messages:         [new AIMessage('Cancelled.')],
      pendingWriteCall: null,
    };
  }

  // Unrecognized — safer to cancel and ask the user to re-state.
  // Treating an ambiguous reply as "yes" can lead to unintended writes.
  return {
    messages: [new AIMessage(
      `I didn't catch a yes/no for "${state.pendingWriteCall.summary}". Cancelling for safety — please re-state your request if you'd like to proceed.`,
    )],
    pendingWriteCall: null,
  };
}
