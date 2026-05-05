# Slice 46b — Native `interrupt()` for write-action confirmation

> **Prerequisite:** Slice 46 deployed (PostgresSaver — required because `interrupt()` only works with a real durable checkpointer; MemorySaver loses the suspended state on pod death).
> **Package:** `@cip/teams-bot`.
> **Verify:** "disable Jane Smith" → confirm prompt arrives → `kubectl rollout restart -n cip-app deploy/teams-bot` → reply "yes" → write executes correctly. Same with "no" → cancel. Same with "do it but for Bob instead" → re-plan path.

---

## Why

The current write-action confirmation pattern predates LangGraph 1.x's first-class `interrupt()` API. It works, but it's hand-rolled in three places:

1. **`confirm` node** sets `state.pendingWriteCall` and returns; the graph reaches END.
2. **State** carries a `PendingWriteCall` field across the suspension.
3. **`ingest` on resume** classifies the user's reply against `lg.affirmation_patterns` / `lg.cancellation_patterns` and either synthesizes the saved tool call (so execute can run it) or drops it.

Three things are wrong with this:

- **Affirm/cancel parsing lives in `ingest`** — the wrong place. The semantics of "yes/no to a confirm" belong in the confirm node, not the front door.
- **`pendingWriteCall` is a state-shape leak** — every checkpoint serializes a field that exists only for one specific control-flow case.
- **Two paths through `ingest`** — normal turn vs resume-from-confirm — hide the actual conversation flow behind a branch that exists only for this one case.

LangGraph 1.x's `interrupt(payload)` + `Command({resume: value})` does this natively. The graph suspends at the `interrupt()` call, the checkpoint captures the suspension point automatically, and the next `invoke()` with a `Command({resume})` continues *from inside the same node* with the resume value as the call's return.

## What this slice IS

1. **Replace the hand-rolled pattern with `interrupt()`** in [confirm.ts](../packages/teams-bot/src/langgraph/nodes/confirm.ts):
   ```ts
   // confirm.ts (new shape)
   export async function confirmNode(state, config) {
     // payload sent to the bot runner so it knows what to render
     const decision = interrupt({
       kind:      'write_confirm',
       summary:   state.proposedWriteCall.summary,
       toolName:  state.proposedWriteCall.toolName,
       toolArgs:  state.proposedWriteCall.toolArgs,
     });
     // execution resumes here on the next invoke
     // decision = string (whatever the user replied)
     const tunables = await getTunables(state.tenantId);
     const verdict = classifyConfirmReply(decision, tunables);
     if (verdict === 'affirm') {
       const ai = new AIMessage({
         content: '',
         tool_calls: [{
           id:   randomToolCallId(),
           name: state.proposedWriteCall.toolName,
           args: state.proposedWriteCall.toolArgs,
         }],
       });
       return { messages: [ai], proposedWriteCall: null };
     }
     if (verdict === 'cancel') {
       return {
         messages: [new AIMessage('Cancelled.')],
         proposedWriteCall: null,
       };
     }
     // Unrecognized — drop the pending call and let the regular turn re-plan
     // by NOT setting tool_calls. ingest already appended the HumanMessage on
     // the resume invoke, so plan will see the new context.
     return { proposedWriteCall: null };
   }
   ```

2. **Rename `pendingWriteCall` → `proposedWriteCall`** to signal "the planner proposed this; confirm is awaiting decision." The previous name was tied to the resume-classification dance which no longer exists.

3. **Remove the resume branch from `ingest`.** [ingest.ts](../packages/teams-bot/src/langgraph/nodes/ingest.ts) collapses to: append the HumanMessage, reset per-turn fields (including the `candidateTools: []` reset added in Slice 46 — keep that). That's it. The 50-line affirmation/cancellation handler moves into a `classifyConfirmReply()` helper called from `confirm`.

4. **Remove the conditional edge `routeAfterIngest`** from [graph.ts](../packages/teams-bot/src/langgraph/graph.ts). With native interrupts, the graph automatically resumes inside `confirm` — there is no "synthesize tool_calls in ingest then route to execute" path anymore. The graph shrinks to a single ingest→discover→triage edge.

5. **Update the runner.** [runner.ts](../packages/teams-bot/src/langgraph/runner.ts) detects suspended state by checking `result.tasks` for active interrupts (the LangGraph 1.x API surface). When present:
   - Read the interrupt payload to render the confirmation message.
   - Persist nothing extra — the checkpoint already holds the suspended graph.
   - On the next user message, invoke with `new Command({resume: userText})` instead of fresh state.

## What this slice is NOT

- **Not a behavior change.** Same UX: bot proposes a write → user confirms or cancels → bot acts or stops. Tunables `lg.affirmation_patterns` and `lg.cancellation_patterns` continue to drive the verdict.
- **Not a way to add multi-step interrupts.** This stays single-decision. If we want "edit then confirm" later, that's a separate design.
- **Not a refactor of the gateWrite gate.** `gateWriteAction` still decides whether a confirm is needed; only the *handling* of confirm is changing.
- **Not a removal of `lg.authorized_write_verbs`.** Still bypasses the gate when the user's message names a permitted write verb.

---

## Files in scope

```
packages/teams-bot/src/langgraph/nodes/confirm.ts                NEW shape (rewritten)
packages/teams-bot/src/langgraph/nodes/ingest.ts                 (delete resume branch)
packages/teams-bot/src/langgraph/state.ts                        (rename + update reducer; field type same)
packages/teams-bot/src/langgraph/graph.ts                        (remove routeAfterIngest; simplify edges)
packages/teams-bot/src/langgraph/nodes/gate-write.ts             (rename pendingWriteCall → proposedWriteCall)
packages/teams-bot/src/langgraph/runner.ts                       (detect interrupts; use Command({resume}))
packages/teams-bot/src/langgraph/util/classify-confirm-reply.ts  NEW (extracted helper)

slices/SLICE_46B_NATIVE_INTERRUPT.md                             this file
```

---

## Hard rules

- **No state field added.** The whole point is to remove the resume-handling state. `proposedWriteCall` is `pendingWriteCall` renamed; total field count unchanged.
- **No tunable removed.** `lg.affirmation_patterns` and `lg.cancellation_patterns` are still consulted by `classifyConfirmReply()`. Behavior identical at the tunable level.
- **Idempotent on duplicate yes**: if the user sends "yes" twice (e.g., they got bored and tapped twice), the second yes invokes a graph with no active interrupt — runner falls through to normal turn handling. Don't crash.
- **All confirm logic in confirm.ts.** No part of the affirm/cancel decision lives in `ingest` or `runner` after this slice.
- **runner detects interrupts before treating state as "completed."** A suspended graph has `result.__interrupt__` (or `result.tasks[*].interrupts` depending on 1.x's exact surface — verify at implementation time). If detected, render the interrupt's `summary` and DO NOT log it as a completed turn.

---

## Verification

**Affirm path:**
1. Send "disable Jane Smith".
2. Bot replies "About to: Disable Jane Smith. Reply yes/no."
3. Confirm via `gh api` or Langfuse trace that the graph is *suspended* (not ended) — the checkpoint should show an active interrupt task on the `confirm` node.
4. `kubectl rollout restart -n cip-app deploy/teams-bot`. Wait for the new pod to be ready.
5. Reply "yes".
6. Verify: the disable tool was actually called against hr-service; the confirmation message arrived ("Disabled Jane Smith." or whatever the tool result line says).

**Cancel path:**
1. Send "disable Jane Smith".
2. Reply "no".
3. Verify: no tool call executed (check hr-service audit log); bot replies "Cancelled."

**Re-plan path:**
1. Send "disable Jane Smith".
2. Reply "actually disable Bob Smith instead".
3. Verify: no tool call executed for Jane; the planner re-runs against the new message and proposes the Bob disable (which itself goes through the confirm gate again).

**Idempotency:**
1. Send "disable Jane Smith". Reply "yes".
2. Wait for the success reply.
3. Send "yes" again.
4. Bot should treat it as a fresh chitchat-y turn (planner falls back to a friendly reply); no second tool execution.

**Multi-replica:** scale teams-bot to 2 replicas; send the confirm; reply "yes" and watch which pod handled the resume. Either pod should resume correctly because PostgresSaver shares the suspended checkpoint.

---

## Out of scope (deferred)

- Multi-step interrupts (e.g., "what should I name it?" → "give me a number" → "confirm").
- A typed Command builder that wraps `Command({resume: text})` for ergonomics — the raw constructor is fine for one usage site.

---

## Cross-slice notes

- This slice depends on Slice 46 being live. With MemorySaver, `interrupt()` would silently lose the suspension on pod death.
- Slice 48's Langfuse callback (already drafted) will surface interrupts as a `__interrupt__` span in the trace tree — useful for debugging cases where the wrong message was rendered.
- The `proposedWriteCall` rename is intentionally non-load-bearing — purely a clarity fix. If reviewers prefer keeping `pendingWriteCall`, we can revert the rename without affecting the architecture.
