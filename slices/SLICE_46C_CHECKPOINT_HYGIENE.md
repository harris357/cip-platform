# Slice 46c — LangGraph 1.x performance + checkpoint hygiene

> **Prerequisite:** Slice 46 deployed (PostgresSaver in production). **Slice 46b is now a HARD prerequisite** — Part 4 (async checkpointer durability) is unsafe without native `interrupt()`. Recommended order is 46 → 46b → 46c.
> **Package:** `@cip/teams-bot`, `@cip/hr-service` (cron CronJob).
> **Verify:** `checkpoint_blobs` row count + size growth tracked over a week. Mid-turn checkpoints no longer carry the candidateTools array. Retention cron deletes stale checkpoints without affecting any active thread. Per-turn p50 graph time drops by ~500-900ms (parallel tool exec + async durability) without regressing correctness; Langfuse spans show prompt-cache hits on iteration ≥ 2 of `plan`.

---

## Why

Two motivations bundled into one slice because all five parts touch the LangGraph runtime layer and share a single deploy + verification window:

**Hygiene (Parts 1+2):**

1. **`candidateTools` gets serialized on every mid-turn checkpoint.** It's reset to `[]` by `ingest`, but `discover` populates it (~30 MCP tools × ~1 KB each = ~30 KB), `triage` reads it, `plan` reads it. Each of those node transitions writes a checkpoint that includes the full array. Per turn: ~5-7 mid-turn checkpoints × 30 KB = 150-200 KB of useless serialization that re-derives identically on the next turn anyway.

2. **No retention.** PostgresSaver keeps the entire checkpoint chain forever. Production traffic of ~100 turns/day across ~50 threads = ~500-700 new checkpoints per day. Tables grow without bound. After 60 days, `checkpoint_blobs` will be > 1 GB and slow down (a) checkpointer reads (which scan back to load thread state) and (b) backups.

**Performance (Parts 3+4+5):**

Spot-check of 12 production turns showed p50 ~5–7s per turn, p95 ~9.5s. Three sub-second wins without changing behavior:

3. **Tool calls run sequentially.** When the planner emits multiple `tool_calls` in one AIMessage (e.g., `lookup_employee` + `list_certs` + `get_role_assignments`), `execute.ts` awaits them one-by-one. They're independent HTTP calls; `Promise.all` lets them overlap.

4. **`PostgresSaver` writes are sync by default.** LangGraph 1.x's `compile({durability})` exposes `"sync" | "async" | "exit"`. Sync blocks each transition (~10-30ms × 7 transitions = ~100ms per turn). For non-suspend transitions, async is fine — the user-visible reply gets sent only after `respond` runs, so checkpoint write latency on EARLIER nodes is dead weight.

5. **Mistral has automatic prompt caching** but we don't measure whether we're hitting it. Iteration ≥ 2 of `plan` in a tool loop shares the same system+tool_reference prefix; the cache hit is potentially worth 100–300ms. Langfuse spans expose cache-hit telemetry from LiteLLM — we just need to wire it through `callLLM` metadata so it shows up.

## What this slice IS

1. **Custom serializer for `candidateTools`** so it dumps as `null` and loads as `[]`. Every checkpoint stays small.

2. **Retention cron** as a Kubernetes `CronJob` in `cip-app`, runs nightly. Per-thread retention rule: keep the **latest** checkpoint plus any with an active interrupt; delete everything else.

3. **Parallel tool execution.** `execute.ts` runs `Promise.all(tool_calls.map(...))` instead of a sequential loop. ToolMessage order in state may not match emit order — that's fine because messages are joined to AIMessage tool_calls by `tool_call_id`, not array index.

4. **`durability: "async"`** in `graph.compile({checkpointer, durability: "async"})`. Native `interrupt()` (Slice 46b) handles its own forced-sync write at suspend points; async is safe everywhere else. **Without 46b**, this is unsafe — confirm-resume could lose the suspended state if a pod dies between async-write-issue and disk fsync.

5. **Prompt-cache visibility.** Pipe LiteLLM's `cache_hit` / `cache_creation_input_tokens` / `cache_read_input_tokens` fields through `callLLM` into Langfuse generation metadata. No client-side caching change — Mistral's automatic caching already runs server-side; we just observe it. Slice 48's per-node trace tree makes the win measurable.

## What this slice is NOT

- **Not a behavior change.** No graph nodes added. No new tunables (Parts 3, 4 are static config). No state shape changes.
- **Not a custom checkpointer.** We continue to use `PostgresSaver` as-is — only the per-field serde for `candidateTools` is overridden, plus the durability flag flipped.
- **Not a manual prompt-caching client.** Mistral does it automatically when prefixes match across calls within ~5 min. We measure, we don't manage.
- **Not time-travel preservation.** Historical chain dropped intentionally.
- **Not a partition/sharding migration.** Only relevant > 10 GB.

---

## Part 1: Ephemeral `candidateTools`

LangGraph 1.x's `Annotation` accepts a custom serde via the channel options. The cleanest pattern:

```ts
// packages/teams-bot/src/langgraph/state.ts (excerpt — diff vs current)
import { Annotation } from '@langchain/langgraph';

const ephemeralListSerde = {
  // dump returns what gets written to the checkpoint blob
  dump: () => null,
  // load returns what the in-memory state gets when a checkpoint is restored
  load: () => [],
};

candidateTools: Annotation<McpTool[]>({
  reducer: (_prev, next) => next,
  default: () => [],
  // 1.x: the channel exposes serde overrides via the third Annotation arg.
  // Verify exact API shape at implementation time — may be `serde:` or
  // `serdes:` depending on the published 1.2.9 surface.
  serde: ephemeralListSerde,
}),
```

After this:
- The checkpoint blob carries `null` for `candidateTools`.
- A pod restart that resumes a thread loads `[]`; the *next* turn's `discover` node repopulates it.
- The reset-to-`[]` inside `ingest` (added in Slice 46) becomes redundant — keep it for now as defensive belt-and-suspenders, drop in a later cleanup once we trust the serde override.

If LangGraph 1.x doesn't expose serde overrides directly on `Annotation` (verify at implementation time — the 1.2.9 source is the source of truth), the fallback is to drop `candidateTools` from `StateAnnotation` entirely and pass it through node closures or a side channel:
- `discover` returns `{ ...state, candidateTools }` only as a return value, never as a persisted state field.
- `triage`, `plan` receive it as a constructor-bound prop on the per-request closures (similar to how `ctx` is closed over).
- Net: zero rows ever written for it; trade-off is the field becomes invisible to LangGraph Studio.

Pick the cleaner API at implementation time.

## Part 2: Retention cron

A new `CronJob` in `cip-app`, running nightly at 03:30 (low-traffic). Image: reuse `hr-service` (it has the pg client and the `cip_hr` connection string).

```yaml
# packages/hr-service/helm/templates/checkpoint-gc-cronjob.yaml (NEW)
apiVersion: batch/v1
kind: CronJob
metadata:
  name: checkpoint-gc
  namespace: cip-app
spec:
  schedule: "30 3 * * *"
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 5
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: hr-service
          restartPolicy: OnFailure
          containers:
            - name: gc
              image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"
              command: ["node", "dist/scripts/checkpoint-gc.js"]
              envFrom:
                - secretRef:
                    name: hr-service-credentials
```

Script — keeps:
- The latest checkpoint per thread (by `created_at DESC`).
- Any checkpoint that's part of an active suspension (`pending_sends` non-empty, or whatever the LG 1.x suspended-state predicate is — verify at implementation).
- Last 24h of any thread (so a debug session can replay a recent thread).

Deletes everything else, plus orphaned `checkpoint_blobs` and `checkpoint_writes` rows.

```sql
-- packages/hr-service/src/scripts/checkpoint-gc.sql (template — confirm column
-- names against the live schema PostgresSaver creates)

WITH keep AS (
  SELECT thread_id, checkpoint_id
  FROM (
    SELECT thread_id, checkpoint_id,
           ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY created_at DESC) AS rn,
           created_at
    FROM checkpoints
  ) t
  WHERE rn = 1                              -- newest per thread
     OR created_at > NOW() - INTERVAL '24 hours'  -- recent
     -- TODO: add an OR clause covering active interrupts once we confirm
     -- which column tracks suspended state in PostgresSaver's 1.0.1 schema.
)
DELETE FROM checkpoints
 WHERE (thread_id, checkpoint_id) NOT IN (SELECT * FROM keep);
-- Cascade clears checkpoint_blobs / checkpoint_writes (verify FK behavior;
-- if not cascading, run a follow-up DELETE on those tables).
```

Wrapped in a TS script so we get logging:
```ts
// packages/hr-service/src/scripts/checkpoint-gc.ts
const t0 = Date.now();
const before = await client.query(`SELECT COUNT(*) FROM checkpoints`);
await client.query(GC_SQL);
const after  = await client.query(`SELECT COUNT(*) FROM checkpoints`);
console.log(
  `[checkpoint-gc] before=${before.rows[0].count} after=${after.rows[0].count} ` +
  `deleted=${Number(before.rows[0].count) - Number(after.rows[0].count)} ` +
  `duration_ms=${Date.now() - t0}`,
);
```

---

## Part 3: Parallel tool execution

```ts
// packages/teams-bot/src/langgraph/nodes/execute.ts (sketch — diff vs current)
const results = await Promise.all(
  last.tool_calls.map(async call => {
    const known = state.candidateTools.find(t => t.name === call.name);
    if (!known) return refusedToolMessage(call, 'unknown_tool');
    try {
      const result = await executeTool(call.name, (call.args ?? {}) as Record<string, unknown>, ctx);
      return { tool: new ToolMessage({ tool_call_id: call.id ?? '', content: stringify(result) }),
               fact: distillFact(call.name, result) };
    } catch (err) {
      return { tool: refusedToolMessage(call, 'execution_error', String(err)),
               fact: `${call.name} threw: ${String(err)}` };
    }
  }),
);
return {
  messages:      results.map(r => r.tool),
  lastToolFacts: results.map(r => r.fact),
};
```

Hard rules:
- **Tool ordering is by `tool_call_id`, not array index.** OpenAI/LiteLLM and Mistral all use the ID join; emit order doesn't matter.
- **Every tool_call still produces exactly one ToolMessage** — never zero (would orphan a tool_call_id), never two.
- **`Promise.all` not `Promise.allSettled`.** Per-tool errors are caught inside the map; the outer promise should never reject.
- **Step counter unchanged** — still reflects the number of `plan` iterations, not tool fan-out.

## Part 4: Async checkpointer durability

```ts
// packages/teams-bot/src/langgraph/graph.ts (one-line change)
return graph.compile({
  checkpointer,
  durability: 'async',
});
```

Hard rules:
- **Slice 46b MUST be live first.** Native `interrupt()` issues a synchronous checkpoint at the suspension point regardless of the graph-level `durability` setting; without it, our hand-rolled `pendingWriteCall` pattern races with async writes and can lose the confirm state on pod death.
- **Verify against pod-restart smoke test.** Same tests as 46b — start a confirm, restart the pod, reply "yes" — must still work end-to-end.
- **Document the failure mode** in the graph.ts comment: "async durability — last-checkpoint loss on pod death is acceptable for non-suspend transitions because the next user message will reset to ingest with the persisted thread state from before the lost write."

## Part 5: Prompt-cache visibility

`callLLM` already attaches OpenAI-shaped metadata to Langfuse generations. LiteLLM should expose Mistral's cache fields in the response payload (`usage.prompt_tokens_details.cached_tokens` per OpenAI's standard) when caching fires — but verify at implementation time. If LiteLLM doesn't surface the fields for Mistral, log the entire `usage` object once for inspection and adapt to whatever shape LiteLLM emits. (This is hedged because Mistral's caching API has shifted across releases and LiteLLM's normalization may lag.)

```ts
// packages/shared/src/clients/litellm.ts (sketch — inside callLLM)
const usage = resp.usage as any;
const cachedTokens = usage?.prompt_tokens_details?.cached_tokens ?? 0;
const totalTokens  = usage?.prompt_tokens ?? 0;
generationSpan.update({
  metadata: {
    ...existingMetadata,
    cache_hit: cachedTokens > 0,
    cached_tokens:  cachedTokens,
    total_prompt_tokens: totalTokens,
    cache_hit_ratio: totalTokens > 0 ? cachedTokens / totalTokens : 0,
  },
});
```

Hard rules:
- **No client-side caching.** Mistral handles it; we observe.
- **No new tunable.** This is pure telemetry.
- **Verification = a Langfuse generation for `bot.plan` on iteration 2 of a turn shows `cache_hit: true`** with non-zero `cached_tokens`. If it doesn't, prompt isn't stable enough — investigate (likely a non-deterministic field in the system prompt template).

---

## Files in scope

```
packages/teams-bot/src/langgraph/state.ts                                (custom serde for candidateTools)
packages/teams-bot/src/langgraph/graph.ts                                (durability: 'async')
packages/teams-bot/src/langgraph/nodes/execute.ts                        (Promise.all parallel exec)

packages/shared/src/clients/litellm.ts                                   (cache-hit metadata pipe)

packages/hr-service/src/scripts/checkpoint-gc.ts                         NEW
packages/hr-service/helm/templates/checkpoint-gc-cronjob.yaml            NEW
packages/hr-service/Dockerfile                                            (no change unless build excludes scripts/ — verify)

slices/SLICE_46C_CHECKPOINT_HYGIENE.md                                    this file
```

---

## Hard rules

- **GC must never delete a thread's only checkpoint.** Always keep at least the latest per `thread_id`. The retention SQL above does this via `ROW_NUMBER() OVER (... ORDER BY created_at DESC) = 1`. Triple-check before merging.
- **GC must not run while a thread is suspended.** If we can identify suspended-state rows, exclude them. If we can't (LG 1.x's exact schema for active interrupts is unclear at draft time), be conservative: keep the most recent N checkpoints per thread instead of just 1, set `N = 3`. Avoids any chance of deleting a row that holds the suspension.
- **GC failures are non-fatal.** A failed run logs and exits non-zero (so `failedJobsHistoryLimit` retains it for inspection). Bot operation isn't affected.
- **No magic numbers in the GC script.** Retention window (`24 hours`) and per-thread keep count (`1` or `3`) come from env vars `CHECKPOINT_GC_KEEP_HOURS` and `CHECKPOINT_GC_KEEP_PER_THREAD`, defaulted in code.
- **Idempotent.** Two consecutive runs leave the table identical. (Trivially true for a `DELETE` based on a deterministic predicate, but worth asserting in the test.)

---

## Verification

**Custom serde:**
1. After deploy, send a turn that triggers discover.
2. Query `SELECT pg_column_size(blob) FROM checkpoint_blobs WHERE channel='candidateTools'` — expect a small number (NULL or empty array).
3. Inspect a mid-turn checkpoint's blob: confirm it does NOT contain a serialized `candidateTools` array.

**Retention cron — dry run:**
1. `kubectl create job --from=cronjob/checkpoint-gc checkpoint-gc-manual -n cip-app`
2. `kubectl logs -n cip-app job/checkpoint-gc-manual` shows `[checkpoint-gc] before=N after=M deleted=N-M`.
3. Confirm a known-active thread (currently suspended at a confirm) is NOT in the deleted set — its checkpoint row is still present.

**Retention cron — scheduled:**
1. After 7 days, `SELECT COUNT(*) FROM checkpoints` should be ~ steady-state instead of growing linearly.
2. `kubectl get jobs -n cip-app | grep checkpoint-gc` shows successful runs at 03:30 each day.

**No regression on resume:**
1. Open a thread, send "disable Jane Smith", get the confirm prompt.
2. Manually trigger the GC cron.
3. Reply "yes" — the resume must still work (i.e., the GC didn't kill the suspended checkpoint).

---

## Out of scope (deferred)

- Time-travel debugging (intentionally — we drop historical chains).
- Partitioning `checkpoint_blobs` by month (only relevant > 10 GB).
- Auto-discovery of suspended-state rows (the conservative `keep last 3` is good enough until we confirm the 1.x schema).
- Parallelizing `discover ‖ triage` — separate graph-shape change; tracked in a future perf slice.
- Client-side prompt caching (LangChain has primitives; we don't need them yet because Mistral does it server-side).

---

## Cross-slice notes

- The custom serde lets us drop the explicit `candidateTools: []` reset from `ingest.ts` in a future cleanup; for now it's harmless belt-and-suspenders.
- If 46b ships first (recommended), `proposedWriteCall` (the renamed `pendingWriteCall`) is a small field — no special serde needed.
- The same hr-service image runs the GC, which means the GC ships with every hr-service deploy. If we want decoupled cadence, split into its own image later.
