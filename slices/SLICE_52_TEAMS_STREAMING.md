# Slice 52 — Streaming partial responses to Teams

> **Prerequisite:** Slice 46 (durable state — streaming spans multiple sendActivity calls; if a pod dies mid-stream, a checkpoint must capture progress). Slice 48 (telemetry — we want to measure whether streaming actually improves perceived latency before making it the default).
> **Package:** `@cip/teams-bot`.
> **Verify:** A long planner response surfaces in Teams as a "typing…" indicator that resolves to the final message; total wall-clock time is unchanged but **perceived latency** drops because the user sees activity within ~500 ms instead of waiting silently.

---

## Why this slice exists, and why it's gated

LangGraph 1.x supports `streamMode: 'messages'` for token-level streaming. **Teams Bot Framework**, however, doesn't speak token-level streaming over the messaging channel — `sendActivity` is request/response. The closest primitives are:

1. **Typing indicator** (`type: 'typing'` activity) — shows "Bot is typing…" in the Teams UI. Cheap, low-information.
2. **Adaptive card edit-in-place** — send a card, then edit its content via `updateActivity`. Renders on desktop + mobile. More expressive but heavier — every edit is an API call.
3. **Multiple sequential `sendActivity` messages** — can render as a thread of "Working on it…" → "Found 3 employees…" → "Final answer." Works, but clutters the channel.

**This slice is GATED.** We don't ship streaming until Slice 48 telemetry shows that p95 turn latency is high enough that perceived-latency wins justify the complexity. Right now most turns are 800–2500 ms — at the edge of where streaming helps. If telemetry shows a fat tail at 4 s+, streaming is worth it.

This slice is therefore split into two sub-decisions:
1. **Should we stream?** — answered by Slice 48 telemetry.
2. **How should we stream?** — answered by this slice if (1) is yes.

## What this slice IS (if telemetry justifies it)

1. **Pattern decision: typing indicator + final message** as the default. Cheapest UX win, most predictable.
   - As soon as `runner.ts` invokes the graph, send `{ type: 'typing' }`.
   - When the graph emits an AIMessage from `respond` or `confirm`, send the final activity with the actual content.
   - On long graphs (e.g., a tool loop hitting `lg.max_steps`), refresh the typing indicator every ~3 s so Teams doesn't time it out.
2. **Pattern: progress chips for tool-loop turns.** When `stepCount > 1` (i.e., the planner is iterating), send a one-liner `"Looking up …"` after each tool call's result, then replace it (via `updateActivity`) with the next progress line. Final response replaces the last progress line.
3. **Tunable: `lg.streaming_mode`** with values `none` (current behavior), `typing` (just the indicator), `progress` (chips + indicator + final). Default `typing` initially; promote to `progress` per-tenant after observation.

## What this slice is NOT

- **Not token-by-token streaming.** Teams isn't built for it; we'd produce more API calls than wins.
- **Not server-side LLM streaming for cost reasons.** LiteLLM passes through; whether the LLM streams internally doesn't affect Teams UX.
- **Not a refactor of `runner.ts`'s graph.invoke loop.** We use LangGraph's `stream()` API in addition to `invoke()`, but the rest of the runner stays.

---

## Implementation sketch

```ts
// packages/teams-bot/src/langgraph/runner.ts (sketch)
import { Activity } from '@microsoft/agents-activity';

await context.sendActivity(Activity.fromObject({ type: 'typing' }));

// Optional progress chip — only when streaming_mode = 'progress'
let progressActivityId: string | undefined;
if (mode === 'progress') {
  const p = await context.sendActivity(Activity.fromObject({
    type: 'message',
    text: '_Looking it up…_',
  }));
  progressActivityId = p?.id;
}

// LangGraph 1.x async iterable — yields {node, state-update} on each transition
const iter = await graph.stream(initialState, {
  configurable: { thread_id: threadId },
  streamMode:   'updates',
});
let finalState = initialState;
for await (const update of iter) {
  finalState = mergeState(finalState, update);

  if (mode === 'progress' && update.execute) {
    const tool = lastAttemptedTool(update);
    if (tool && progressActivityId) {
      await context.updateActivity(Activity.fromObject({
        id:   progressActivityId,
        type: 'message',
        text: `_Used \`${tool}\`…_`,
      }));
    }
  }

  // Refresh typing every ~3 s so Teams doesn't drop the indicator
  if (Date.now() - lastTyping > 2500) {
    await context.sendActivity(Activity.fromObject({ type: 'typing' }));
    lastTyping = Date.now();
  }
}

// Final reply — overwrite the progress chip if any, else send fresh
const outbound = pickFinalAIMessage(finalState);
if (mode === 'progress' && progressActivityId) {
  await context.updateActivity(Activity.fromObject({
    id:   progressActivityId,
    type: 'message',
    text: outbound,
  }));
} else {
  await context.sendActivity(outbound);
}
```

## Tunables

New seeded global default:

| Key | Default | Purpose |
|---|---|---|
| `lg.streaming_mode` | `"typing"` | One of: `"none"`, `"typing"`, `"progress"`. Per-tenant overridable. |

---

## Files in scope

```
packages/teams-bot/src/langgraph/runner.ts                         (rework invoke → stream loop)
packages/teams-bot/src/langgraph/util/progress-renderer.ts         NEW (tool-name → chip text)
packages/hr-service/src/db/migrations/<NNN>_lg_streaming_mode.sql  NEW (seed lg.streaming_mode)

slices/SLICE_52_TEAMS_STREAMING.md                                 this file
```

---

## Hard rules

- **No new failure modes.** If `updateActivity` fails (e.g., Teams returned 410 because the activity expired), fall back to `sendActivity` of the final reply. The user MUST get the final answer regardless of whether progress chips worked.
- **No regression in `total_ms`.** The `[turn]` log line continues to record total wall-clock; if streaming somehow makes runs slower, telemetry will show it and we revert by setting `lg.streaming_mode = 'none'` per-tenant.
- **Typing indicators don't outlive the turn.** Always send a final message that replaces or overrides the typing state. Never leave the user staring at "Bot is typing…" forever.
- **Per-tenant kill switch.** `lg.streaming_mode = 'none'` reverts a tenant to current behavior with zero code changes.
- **No magic numbers.** Typing-refresh interval (2500 ms) is a tunable: `lg.streaming_typing_refresh_ms`. Default it; document it.

---

## Verification

**Telemetry-gated decision (precondition):**
1. After Slice 48 has been live for ~2 weeks, query `bot_turn_metrics` for p50/p95/p99 of `total_ms` per tenant.
2. If p95 < 2500 ms across the board, **don't ship this slice** — perceived-latency wins are marginal. Revisit when traffic patterns change.
3. If p95 > 4000 ms or the long tail materially affects UX complaints, proceed.

**Functional verification (assuming we proceed):**

**Mode = `none`:**
1. Set `lg.streaming_mode = 'none'`. Send a turn. Behavior identical to today (single `sendActivity` of the final reply).

**Mode = `typing`:**
1. Send a turn that triggers a tool call.
2. Within 500 ms, the Teams client shows "Bot is typing…".
3. When the graph completes, the typing indicator vanishes and the final reply appears.

**Mode = `progress`:**
1. Send "find Jane Smith and disable her" — a multi-step turn.
2. See: progress chip "_Looking it up…_" → updates to "_Used `lookup_employee`…_" → updates to "_Used `disable_employee`…_" → replaced by the final confirmation message.
3. Total wall-clock not slower than mode=`typing`.

**Failure modes:**
1. Force an `updateActivity` to fail (e.g., kill the WebSocket mid-turn). Confirm the bot still sends the final reply via `sendActivity`.
2. Long turn (> 8 s): typing indicator refreshes; doesn't drop.

---

## Out of scope (deferred)

- Token-level streaming (different transport entirely; not Teams-friendly).
- Adaptive card progress widgets (richer UI but heavier API spend; only worth it if `progress` mode itself proves valuable).
- Streaming for non-Teams channels (no other channels today).

---

## Cross-slice notes

- The decision to ship is gated on Slice 48 data. If Slice 48 ships and shows latency is fine, this slice is documented but not implemented.
- Slice 46b's native interrupt pattern is friendly to streaming — when the graph suspends at a `confirm` interrupt, the runner stops the stream loop and renders the confirmation message. No special-case needed.
- LangGraph's `streamMode: 'updates'` is what we use here. `'messages'` (token-level) would require Teams to support partial assistant messages, which it doesn't.
