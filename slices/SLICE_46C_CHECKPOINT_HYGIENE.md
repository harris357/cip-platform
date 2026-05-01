# Slice 46c — Checkpoint hygiene: ephemeral fields + retention

> **Prerequisite:** Slice 46 deployed (PostgresSaver in production). Slice 46b NOT a hard prerequisite, but recommended order is 46 → 46b → 46c.
> **Package:** `@cip/teams-bot`, `@cip/hr-service` (cron CronJob).
> **Verify:** `checkpoint_blobs` row count + size growth tracked over a week. Mid-turn checkpoints no longer carry the candidateTools array. Retention cron deletes stale checkpoints without affecting any active thread.

---

## Why

PostgresSaver writes a checkpoint after **every node transition**. Two issues:

1. **`candidateTools` gets serialized on every mid-turn checkpoint.** It's reset to `[]` by `ingest`, but `discover` populates it (~30 MCP tools × ~1 KB each = ~30 KB), `triage` reads it, `plan` reads it. Each of those node transitions writes a checkpoint that includes the full array. Per turn: ~5-7 mid-turn checkpoints × 30 KB = 150-200 KB of useless serialization that re-derives identically on the next turn anyway.

2. **No retention.** PostgresSaver keeps the entire checkpoint chain forever. Production traffic of ~100 turns/day across ~50 threads = ~500-700 new checkpoints per day. Tables grow without bound. After 60 days, `checkpoint_blobs` will be > 1 GB and slow down (a) checkpointer reads (which scan back to load thread state) and (b) backups.

This slice addresses both at the data layer — no behavior change.

## What this slice IS

1. **Custom serializer for `candidateTools`** so it dumps as `null` and loads as `[]`. Every checkpoint stays small. The `discover` node still populates the in-memory state for the rest of the turn; only the persisted form is empty.

2. **Retention cron** as a Kubernetes `CronJob` in `cip-app`, runs nightly. Per-thread retention rule: keep the **latest** checkpoint plus any with an active interrupt (suspended state); delete everything else. SQL is bounded and indexed.

3. **Operational metrics** so we can see the cleanup working: a `[checkpoint-gc]` log line per run with `kept`, `deleted`, `duration_ms`.

## What this slice is NOT

- **Not a behavior change.** No graph nodes added or modified. No new tunables. No state shape changes.
- **Not a custom checkpointer.** We continue to use `PostgresSaver` as-is — only the per-field serde for `candidateTools` is overridden.
- **Not time-travel preservation.** We deliberately drop the historical chain because we never use it for replay. If we add a forensic-debug feature later, the cron's retention window becomes a tunable.
- **Not a partition/sharding migration.** Only relevant once tables exceed ~10 GB — far away.

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

## Files in scope

```
packages/teams-bot/src/langgraph/state.ts                                (custom serde for candidateTools)

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

---

## Cross-slice notes

- The custom serde lets us drop the explicit `candidateTools: []` reset from `ingest.ts` in a future cleanup; for now it's harmless belt-and-suspenders.
- If 46b ships first (recommended), `proposedWriteCall` (the renamed `pendingWriteCall`) is a small field — no special serde needed.
- The same hr-service image runs the GC, which means the GC ships with every hr-service deploy. If we want decoupled cadence, split into its own image later.
