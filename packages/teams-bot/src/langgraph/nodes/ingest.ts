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
//
// Slice 48 follow-up: also delineates Langfuse "sessions" — a session
// is a continuous interaction in this thread; >`lg.session_timeout_minutes`
// idle = new session. sessionId is regenerated on timeout; otherwise
// the existing one is preserved and `sessionLastActivityAt` bumped.

import { randomUUID } from 'node:crypto';
import { HumanMessage } from '@langchain/core/messages';
import { getTunables, getTunable } from '../tunables.js';
import type { State } from '../state.js';

function newSessionId(): string {
  // 12-char hex — long enough to be globally unique, short enough to read.
  return randomUUID().replace(/-/g, '').slice(0, 12);
}

export async function ingestNode(state: State): Promise<Partial<State>> {
  const tunables = await getTunables(state.tenantId);
  const timeoutMin = getTunable<number>(tunables, 'lg.session_timeout_minutes', 60);
  const now = Date.now();

  const idleMs = state.sessionLastActivityAt > 0 ? now - state.sessionLastActivityAt : Number.POSITIVE_INFINITY;
  const sessionId = (!state.sessionId || idleMs > timeoutMin * 60_000)
    ? newSessionId()
    : state.sessionId;

  return {
    messages:        [new HumanMessage(state.latestUserText)],
    triageSignals:   null,
    lastToolFacts:   [],
    stepCount:       0,
    // Defensive: clear any stale pendingWriteCall. Native interrupt
    // resumes inside confirm.ts on the next user message; ingest only
    // runs on a fresh-turn invoke. If we somehow got here with a
    // lingering pendingWriteCall (e.g., a failed previous invoke that
    // didn't complete confirm), drop it so we don't act on stale state.
    pendingWriteCall: null,
    sessionId,
    sessionLastActivityAt: now,
  };
}
