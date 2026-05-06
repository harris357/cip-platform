// Slice 45 + 61: respond node — terminal node. Selects the message to
// send to Teams based on graph state.
//
// Response paths:
//   1. Triage clarification path (Slice 45): triage emitted
//      clarificationQuestion and routeOnSignals routed here directly.
//   2. Plan-with-no-tools path (Slice 45): planner emitted an AIMessage
//      with content and no tool_calls.
//   3. Confirm path (Slice 46b): confirmNode added the "About to: X.
//      Reply yes/no" AIMessage.
//
// Slice 61 removed the slice-55 deterministic-tool paths (extractionResult
// missing/ambiguous/complete). The LLM (plan) now handles every tool
// answer; ambiguity is handled by the tool itself returning a structured
// 422 (future slice 62) or by the LLM clarifying in chat.
//
// In all cases, this node doesn't call any LLM — it just identifies
// what to send. The actual sendActivity happens in runner.ts (after
// graph.invoke returns) so we have access to the Teams TurnContext.

import { AIMessage } from '@langchain/core/messages';
import { isAIMessage } from '../util/message-types.js';
import type { State } from '../state.js';

export async function respondNode(state: State): Promise<Partial<State>> {
  // ─── Triage clarification path (Slice 45) ─────────────────────────
  if (state.triageSignals?.needsClarification && state.triageSignals.clarificationQuestion) {
    const last = state.messages[state.messages.length - 1];
    if (!isAIMessage(last) || last.content !== state.triageSignals.clarificationQuestion) {
      return {
        messages: [new AIMessage(state.triageSignals.clarificationQuestion)],
      };
    }
  }

  return {};
}
