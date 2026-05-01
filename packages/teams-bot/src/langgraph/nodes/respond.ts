// Slice 45: respond node — terminal node. Selects the message to send
// to Teams based on graph state.
//
// Three response paths:
//   1. Triage clarification path: triage emitted clarificationQuestion
//      and routeOnSignals routed here directly (no plan/execute ran).
//   2. Plan-with-no-tools path: planner emitted an AIMessage with content
//      and no tool_calls.
//   3. Confirm path: confirmNode added the "About to: X. Reply yes/no" AIMessage.
//
// In all three cases, the latest AIMessage in state.messages IS the
// response. This node doesn't call any LLM — it just identifies what to
// send. The actual sendActivity happens in runner.ts (after graph.invoke
// returns) so we have access to the Teams TurnContext.

import { AIMessage } from '@langchain/core/messages';
import type { State } from '../state.js';

export async function respondNode(state: State): Promise<Partial<State>> {
  // If we routed here from the triage clarification path, ensure the
  // clarification question is the last message.
  if (state.triageSignals?.needsClarification && state.triageSignals.clarificationQuestion) {
    const last = state.messages[state.messages.length - 1];
    if (!(last instanceof AIMessage) || last.content !== state.triageSignals.clarificationQuestion) {
      return {
        messages: [new AIMessage(state.triageSignals.clarificationQuestion)],
      };
    }
  }
  return {};
}
