// Slice 45: ingest node — entry point for every turn.
//
// Two paths:
//   1. Normal turn: append HumanMessage, reset turn-scoped state.
//   2. Resume after confirm interrupt: classify the user reply against
//      affirmation/cancellation patterns and either stage the saved
//      pendingWriteCall for execution or cancel.
//
// State changes signaled by the return shape are merged via reducers.

import { HumanMessage, AIMessage, ToolMessage } from '@langchain/core/messages';
import type { State } from '../state.js';
import { getTunables, getTunable } from '../tunables.js';

export async function ingestNode(state: State): Promise<Partial<State>> {
  const text = state.latestUserText;

  // Resume-from-confirm path: pendingWriteCall is set when the previous
  // turn interrupted at gateWriteAction.
  if (state.pendingWriteCall) {
    const tunables = await getTunables(state.tenantId);
    const affirm = getTunable<string[]>(tunables, 'lg.affirmation_patterns',
      ['yes', 'y', 'confirm', 'go ahead', 'do it', 'ok', 'okay', 'sure']);
    const cancel = getTunable<string[]>(tunables, 'lg.cancellation_patterns',
      ['no', 'n', 'cancel', 'stop', 'never mind', 'nevermind', 'wait']);

    const lower = text.trim().toLowerCase();
    if (affirm.some(p => lower === p || lower.startsWith(`${p} `) || lower.endsWith(` ${p}`))) {
      // Affirmation — synthesize an AIMessage with the saved tool call so
      // executeToolNode can run it. The plan node would otherwise re-plan
      // and might choose differently.
      const ai = new AIMessage({
        content: '',
        tool_calls: [{
          id:   state.pendingWriteCall.toolCallId,
          name: state.pendingWriteCall.toolName,
          args: state.pendingWriteCall.toolArgs,
        }],
      });
      return {
        messages:        [new HumanMessage(text), ai],
        pendingWriteCall: null,
        triageSignals:    null,
        lastToolFacts:    [],
        stepCount:        0,
        candidateTools:   [],
      };
    }
    if (cancel.some(p => lower === p || lower.startsWith(`${p} `) || lower.endsWith(` ${p}`))) {
      // Cancellation — append a synthetic ToolMessage so the planner sees
      // the action was rejected, then re-plan.
      const ai = new AIMessage({ content: 'Cancelled.' });
      return {
        messages:        [new HumanMessage(text), ai],
        pendingWriteCall: null,
        triageSignals:    null,
        lastToolFacts:    [],
        stepCount:        0,
        candidateTools:   [],
      };
    }
    // Unrecognized reply — treat as cancellation but ask the planner to
    // re-plan based on the new message. Drop the pending call.
    return {
      messages:        [new HumanMessage(text)],
      pendingWriteCall: null,
      triageSignals:    null,
      lastToolFacts:    [],
      stepCount:        0,
    };
  }

  // Normal turn: append the HumanMessage, reset per-turn fields.
  return {
    messages:       [new HumanMessage(text)],
    triageSignals:  null,
    lastToolFacts:  [],
    stepCount:      0,
    candidateTools: [],
  };
}

// Re-export for type-checking convenience in tests.
export { HumanMessage, AIMessage, ToolMessage };
