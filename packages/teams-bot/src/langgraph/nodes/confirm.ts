// Slice 45: confirm node — interrupt point for write-action confirmation.
//
// When the graph reaches this node, it sets the latest AIMessage to a
// human-readable confirmation prompt. The graph is configured with
// `interruptBefore: ['confirm']` (no — actually we use the AIMessage as
// the response and let bot.ts detect the interrupt by inspecting state
// after invoke()).
//
// LangGraph supports two interrupt patterns:
//   1. Static `interruptBefore`/`interruptAfter` at compile time.
//   2. Dynamic `NodeInterrupt` via throw or interrupt() function.
//
// We use pattern 1: interruptAfter: ['confirm']. After this node runs:
//   - state.pendingWriteCall is set
//   - state.messages has the AIMessage with the confirm prompt
//   - graph.invoke() returns; bot.ts sends the AIMessage and waits for
//     the next user message
//   - On next user message, ingest sees pendingWriteCall and routes
//     directly to executeTool (or cancels)

import { AIMessage } from '@langchain/core/messages';
import type { State } from '../state.js';

export async function confirmNode(state: State): Promise<Partial<State>> {
  if (!state.pendingWriteCall) {
    return {};
  }
  const ai = new AIMessage(
    `About to: \`${state.pendingWriteCall.summary}\`\n\nReply **yes** to confirm or **no** to cancel.`,
  );
  return { messages: [ai] };
}
