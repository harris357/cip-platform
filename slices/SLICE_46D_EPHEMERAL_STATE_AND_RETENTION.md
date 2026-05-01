# Slice 46d — Ephemeral candidateTools + checkpoint/metrics retention

> **Prerequisites:** Slice 46 (PostgresSaver), 46b (native interrupt), 46c parts 3+5 deployed. No new runtime deps.
> **Package:** `@cip/teams-bot` (state schema migration), `@cip/hr-service` (CronJob + GC script).
> **Verify:** Mid-turn `checkpoint_blobs` rows no longer carry the `candidateTools` array; nightly cron deletes stale checkpoint chains without affecting any active suspended thread; `bot_turn_metrics` retained ≤ 90 days.

---

## Why

Two pieces deferred from Slice 46c because each needs surgery the rest of 46c didn't touch:

### Part 1 — `candidateTools` is mid-turn write amplification

PostgresSaver writes a checkpoint after every node transition. `state.candidateTools` is the user's permitted MCP tool catalog (~30 tools × ~1 KB metadata each). It's set by `discover` and read by `triage`, `plan`, `gateWriteAction`, `execute`. Across one turn that's 5–7 mid-turn checkpoints × ~30 KB serialized = **~150-200 KB of dead weight per turn**. The tool catalog re-derives identically every turn (cached per `(tenant, employee)` for 5 min anyway), so the serialized copy is wasted I/O.

In Slice 46c we tried to mark it ephemeral via a custom serde on `Annotation()`. That API doesn't expose serde overrides in LG 1.x — the proper primitive (`UntrackedValue`) lives in the **new state-schema system** that uses `StateGraph` with a Zod / standard-schema input rather than `Annotation.Root({...})`. Migrating to the new system is ~1 day of careful refactoring across `state.ts`, `graph.ts`, and every node typed `state: State`.

### Part 2 — checkpoint and metrics tables grow unbounded

`PostgresSaver` retains the entire checkpoint chain per thread forever. Production at ~100 turns/day across ~50 threads = ~500-700 new checkpoints per day. After 60 days, `checkpoint_blobs` will be > 1 GB and slow checkpointer reads (which scan back to load thread state) and backups.

`bot_turn_metrics` (Slice 48) has the same dynamic — append-only, no retention.

In Slice 46c we deferred this because it's a separate build path: needs a Helm `CronJob` template, a new container entrypoint script, and SQL written *very* carefully so it can never delete a thread's only checkpoint or any with an active suspended interrupt.

## What this slice IS

1. **Migrate `StateAnnotation` to the new state-schema system** with `StateGraph` accepting a typed schema input. Mark `candidateTools` as `UntrackedValue<McpTool[]>` so it lives in-memory during a turn but is **never serialized to checkpoints**.
2. **Drop the defensive `candidateTools: []` reset** in `ingest.ts` — no longer needed; the field is structurally untracked.
3. **Nightly retention CronJob** in `cip-app` running 03:30 UTC. Image: `hr-service` (already has pg client + DATABASE_URL_HR). Two responsibilities: trim `checkpoints` chains and trim old `bot_turn_metrics` rows.
4. **Operational logging**: per-run `[checkpoint-gc]` and `[metrics-gc]` lines with `before`, `after`, `deleted`, `duration_ms`. Failed runs retained for inspection via `failedJobsHistoryLimit`.

## What this slice is NOT

- **Not a behavior change.** No new graph nodes, no new tunables (parts 1 and 4), no per-turn user-facing diff. Pure data-layer hygiene.
- **Not a custom checkpointer.** We continue using `PostgresSaver` as-is; the GC operates on tables it owns.
- **Not time-travel preservation.** We deliberately drop the historical chain because we never use it for replay. If a future forensic-debug feature needs replay, the retention window becomes a tunable.
- **Not a partition / sharding migration.** Only relevant once tables exceed ~10 GB.
- **Not a permission tightening.** GC pod uses the same `hr-service` ServiceAccount.

---

## Part 1: Untracked `candidateTools`

### Migration shape

LG 1.x's new state-schema API takes a Zod schema (or any standard-schema-compliant schema) instead of `Annotation.Root`:

```ts
// packages/teams-bot/src/langgraph/state.ts (new shape — sketch)
import { StateGraph, MessagesAnnotation } from '@langchain/langgraph';
import { UntrackedValue } from '@langchain/langgraph';
import { z } from 'zod';

const BotStateSchema = z.object({
  threadId:        z.string(),
  tenantId:        z.string(),
  employeeId:      z.string(),
  permissions:     z.record(z.boolean()),
  roles:           z.array(z.string()),
  triageSignals:   TriageSignalsSchema.nullable(),
  pendingWriteCall: PendingWriteCallSchema.nullable(),
  lastToolFacts:   z.array(z.string()),
  stepCount:       z.number(),
  latestUserText:  z.string(),
  turnId:          z.string(),
  summary:         z.string(),
  // messages — special: use the prebuilt MessagesValue
  messages:        MessagesValue,
  // candidateTools — never persisted
  candidateTools:  new UntrackedValue<McpTool[]>(),
});

export const graph = new StateGraph(BotStateSchema)
  .addNode('ingest',     ingestNode)
  // ... etc.
  .compile({ checkpointer });

export type State = z.infer<typeof BotStateSchema> & { candidateTools: McpTool[] };
```

(Exact API names verified at implementation time — `UntrackedValue` and the schema integration may have shifted in 1.2.x. The slice doc tracks the design intent; the implementer adapts to the published surface.)

### What changes elsewhere

- **All node files** typed `state: State` — type alias still works because the inferred state type is structurally similar. Spot-check: `ingest`, `discover`, `triage`, `plan`, `gateWrite`, `confirm`, `execute`, `respond`, `summarize`.
- **`messagesStateReducer`** replaced by the new `MessagesValue` channel — same semantics (append + RemoveMessage).
- **`ingest.ts`**: drop the explicit `candidateTools: []` reset (now defensive belt-and-suspenders only — slice doc retained the reset in 46c on purpose).

### Hard rules — Part 1

- **Field types preserved.** A node returning `{ candidateTools: [...] }` works identically. Only the persistence is different.
- **Zero-byte serialization.** Verify by reading a checkpoint blob post-deploy: `SELECT octet_length(blob) FROM checkpoint_blobs WHERE channel = 'candidateTools'` should return 0 rows or NULL.
- **No regression in resume.** Pod-restart smoke test (Slice 46b) must still pass — confirm the suspended state still resumes correctly.

---

## Part 2: Retention CronJob

### Manifest

```yaml
# packages/hr-service/helm/templates/checkpoint-gc-cronjob.yaml (NEW)
apiVersion: batch/v1
kind: CronJob
metadata:
  name: checkpoint-gc
  namespace: cip-app
spec:
  schedule: "30 3 * * *"              # 03:30 UTC nightly
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
              command: ["node", "dist/scripts/gc.js"]
              envFrom:
                - secretRef:
                    name: hr-service-credentials
              env:
                - name: GC_KEEP_PER_THREAD
                  value: "3"               # last 3 checkpoints per thread (conservative)
                - name: GC_KEEP_RECENT_HOURS
                  value: "24"              # plus everything in last 24h
                - name: GC_METRICS_RETENTION_DAYS
                  value: "90"              # bot_turn_metrics retained 90d
```

### Script — checkpoint chain trim

```ts
// packages/hr-service/src/scripts/gc.ts (sketch)
const t0 = Date.now();
const KEEP_PER_THREAD     = +(process.env['GC_KEEP_PER_THREAD']     ?? '3');
const KEEP_RECENT_HOURS   = +(process.env['GC_KEEP_RECENT_HOURS']   ?? '24');
const METRICS_DAYS        = +(process.env['GC_METRICS_RETENTION_DAYS'] ?? '90');

// 1. Trim checkpoints. Keep:
//    - top KEEP_PER_THREAD per thread by created_at DESC
//    - any with active interrupt (PostgresSaver column TBD — verify at impl)
//    - anything in the last KEEP_RECENT_HOURS (so a debug session can replay)
const beforeCp = (await client.query(`SELECT COUNT(*) FROM checkpoints`)).rows[0].count;
await client.query(`
  WITH keep AS (
    SELECT thread_id, checkpoint_id FROM (
      SELECT thread_id, checkpoint_id, created_at,
             ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY created_at DESC) AS rn
      FROM checkpoints
    ) t
    WHERE rn <= $1
       OR created_at > NOW() - ($2 || ' hours')::INTERVAL
       -- TODO at impl: add OR clause covering active interrupts
       -- once PostgresSaver's exact suspended-state column is confirmed
  )
  DELETE FROM checkpoints
   WHERE (thread_id, checkpoint_id) NOT IN (SELECT thread_id, checkpoint_id FROM keep);
`, [KEEP_PER_THREAD, KEEP_RECENT_HOURS]);
const afterCp = (await client.query(`SELECT COUNT(*) FROM checkpoints`)).rows[0].count;

console.log(
  `[checkpoint-gc] before=${beforeCp} after=${afterCp} ` +
  `deleted=${Number(beforeCp) - Number(afterCp)} ` +
  `duration_ms=${Date.now() - t0}`,
);

// 2. Trim bot_turn_metrics older than METRICS_DAYS.
const t1 = Date.now();
const beforeM = (await client.query(`SELECT COUNT(*) FROM bot_turn_metrics`)).rows[0].count;
await client.query(
  `DELETE FROM bot_turn_metrics WHERE emitted_at < NOW() - ($1 || ' days')::INTERVAL`,
  [METRICS_DAYS],
);
const afterM = (await client.query(`SELECT COUNT(*) FROM bot_turn_metrics`)).rows[0].count;
console.log(
  `[metrics-gc] before=${beforeM} after=${afterM} ` +
  `deleted=${Number(beforeM) - Number(afterM)} ` +
  `duration_ms=${Date.now() - t1}`,
);
```

### Hard rules — Part 2

- **Never delete a thread's only checkpoint.** The conservative `KEEP_PER_THREAD = 3` covers this — even the smallest `ROW_NUMBER` partition keeps three rows. Triple-check the SQL before merging.
- **Active suspended interrupts are sacred.** A thread with a `confirm` pending must NEVER lose its checkpoint, regardless of age. Until we confirm the exact column PostgresSaver uses for "suspended state", `KEEP_PER_THREAD = 3` is the safety net.
- **GC failure is non-fatal.** Failed run logs and exits non-zero (so `failedJobsHistoryLimit` retains it for inspection). Bot operation isn't affected.
- **No magic numbers in the script body** — all retention windows come from env (`GC_KEEP_PER_THREAD`, `GC_KEEP_RECENT_HOURS`, `GC_METRICS_RETENTION_DAYS`), defaulted in code.
- **Idempotent.** Two consecutive runs leave the table identical. (Trivially true for a deterministic-predicate `DELETE`, but worth asserting in the test.)

---

## Files in scope

```
packages/teams-bot/src/langgraph/state.ts                                     (rewrite — schema migration)
packages/teams-bot/src/langgraph/graph.ts                                     (StateGraph signature update if needed)
packages/teams-bot/src/langgraph/nodes/ingest.ts                              (drop candidateTools reset)
# All other node files stay (typed via the new State alias)

packages/hr-service/src/scripts/gc.ts                                         NEW
packages/hr-service/helm/templates/checkpoint-gc-cronjob.yaml                 NEW
packages/hr-service/Dockerfile                                                 (verify scripts/ included in build)
packages/hr-service/package.json                                               (add gc script if helpful)

slices/SLICE_46D_EPHEMERAL_STATE_AND_RETENTION.md                              this file
```

---

## Verification

**Part 1 — Untracked candidateTools:**

1. Deploy. Send a turn that triggers `discover`.
2. ```sql
   SELECT channel, octet_length(blob) AS bytes
     FROM checkpoint_blobs
    WHERE channel = 'candidateTools'
    ORDER BY id DESC LIMIT 5;
   ```
   Expected: zero rows OR `bytes` is null/0.
3. Confirm a mid-turn checkpoint blob: pick a non-final checkpoint, look at the JSON. `candidateTools` field should be absent or `null`.
4. End-to-end smoke: pod restart preserves an in-progress confirm interrupt. Affirm path executes correctly.

**Part 2 — Retention cron:**

1. Manual dry-run: `kubectl create job --from=cronjob/checkpoint-gc gc-manual -n cip-app`
2. `kubectl logs -n cip-app job/gc-manual` shows `[checkpoint-gc]` + `[metrics-gc]` lines.
3. Confirm a known-active suspended thread (just trigger a confirm prompt) is NOT in the deleted set:
   ```sql
   SELECT thread_id, COUNT(*) FROM checkpoints
    WHERE thread_id = '<live-thread-id>'
    GROUP BY thread_id;
   ```
   Expected: ≥ 1 row.
4. Wait one week. ```sql SELECT COUNT(*) FROM checkpoints; ``` should reach steady-state instead of growing linearly.
5. ```sql SELECT MIN(emitted_at) FROM bot_turn_metrics; ``` should converge to ~ `NOW() - 90 days` after the table is older than 90 days.

**Resume safety:**
1. Trigger a confirm prompt.
2. Manually run the GC.
3. Reply "yes". The write must execute correctly — meaning the GC didn't kill the suspended checkpoint.

---

## Out of scope (still deferred)

- LangGraph Studio integration (Slice 51).
- Time-travel debugging (intentionally — historical chains dropped).
- Partitioning `checkpoint_blobs` by month (only relevant > 10 GB).
- Per-tenant retention windows (current design is global).

---

## Cross-slice notes

- **46b is a hard prerequisite for the GC retention rule design.** The "active interrupt" predicate the GC respects depends on knowing what column PostgresSaver uses for suspended state — confirm at implementation time. If the column isn't easily queryable, the conservative `KEEP_PER_THREAD = 3` covers it.
- **The state-schema migration is a forward investment.** LG's API direction is the new schema system; future slices (49 — bot memory adds `memory` and `memorySnippets` fields) will be cleaner under the new schema.
- **`bot_turn_metrics` retention** unblocks Slice 49's "validate convo retrieval before enabling" criterion — having ~90 days of data lets us evaluate it with statistical weight.
