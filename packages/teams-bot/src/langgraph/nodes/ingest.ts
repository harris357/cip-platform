// Slice 46b: ingest is now a single-purpose entry node.
//
// Append the new HumanMessage and reset per-turn fields. That's it.
//
// The Slice 45 resume-from-confirm branch (classify the user's reply
// against affirmation/cancellation patterns and either synthesize a
// saved tool_call or drop pendingWriteCall) is gone — native
// interrupt() (Slice 46b) handles resume directly inside confirm.ts.
// The graph never enters ingest on a resume invoke; it re-enters at
// the suspended interrupt() call inside confirm.

import { HumanMessage } from '@langchain/core/messages';
import type { State } from '../state.js';

export async function ingestNode(state: State): Promise<Partial<State>> {
  return {
    messages:        [new HumanMessage(state.latestUserText)],
    triageSignals:   null,
    lastToolFacts:   [],
    stepCount:       0,
    candidateTools:  [],
    // Defensive: clear any stale pendingWriteCall. Native interrupt
    // resumes inside confirm.ts on the next user message; ingest only
    // runs on a fresh-turn invoke. If we somehow got here with a
    // lingering pendingWriteCall (e.g., a failed previous invoke that
    // didn't complete confirm), drop it so we don't act on stale state.
    pendingWriteCall: null,
  };
}
