# Slice 61 — remove the intent-classifier subsystem

> **Why this exists:** Slice 56 built a Python sklearn intent classifier
> (with retrain workflow, trainer cron, training_data tables, helm chart,
> bot integration, MCP tools). On 2026-05-06 we flipped
> `lg.classifier_enabled = false` and `lg.classifier_honor_decisions = false`
> on the production tenant and measured the LLM-only path: tool selection
> stayed accurate (`get_employee_permissions`, `employee_list` both
> picked correctly) and latency dropped from 3–5s to 1–2s on tool-using
> turns. Cost is ~$0.0003/turn — negligible.
>
> The classifier is no longer earning its keep. Slice 58H planned to
> replicate the same pattern for documents — that plan is also
> abandoned. Slice 61 deletes the entire subsystem: the Python service
> package, the hr-service classifier-lifecycle module, the retrain
> Temporal workflow, the trace-import cronjob, the helm chart, the CI
> build job, and the bot's classifier client.
>
> **Tables and feedback signal (👍/👎) are preserved**, repurposed to
> write Langfuse scores instead of `training_data` rows. Modern
> equivalent of the retrain loop is prompt iteration driven by
> Langfuse-scored traces.
>
> **Slice 58H is formally cancelled** by this slice — the document
> classifier stays LLM-only.

---

## Files in scope

### DELETE — Python service package

```
packages/intent-classifier/                                   DELETED (entire directory)
├── Dockerfile
├── requirements.txt
├── helm/
│   ├── Chart.yaml
│   ├── values.yaml
│   └── templates/
│       ├── deployment.yaml
│       ├── service.yaml
│       └── trainer-cronjob.yaml
├── models/                                                   (artifacts; not in git but worth purging from S3)
├── src/                                                      (Python service code)
└── training/                                                 (Python trainer code)
```

### DELETE — hr-service classifier-lifecycle module

```
packages/hr-service/src/modules/classifier-lifecycle/         DELETED (entire directory)
├── workflows/retrain-model.workflow.ts                       (slice 56N)
├── activities/
│   ├── run-trainer-script.activity.ts
│   ├── trace-import.activity.ts
│   ├── model-promotion.activity.ts
│   ├── record-lineage.activity.ts
│   ├── notify-admin-review.activity.ts
│   └── index.ts
├── mcp-tools/classifier-retrain.tool.ts
└── scripts/start-trace-import.ts
```

### DELETE — Bot classifier integration

```
packages/teams-bot/src/intent/classifier-client.ts            DELETED (HTTP client to the classifier service)
packages/teams-bot/src/langgraph/nodes/classify.ts            DELETED (graph node that calls the classifier)
packages/teams-bot/src/intent/disambiguation-card.ts          DELETED (rendered when classifier returned ambiguous)
packages/teams-bot/src/intent/clarification-templates.ts      DELETED (used by classifier-driven clarify path)
packages/teams-bot/src/intent/feedback-correction-card.ts     DELETED (admin corrects a classifier decision)
packages/teams-bot/src/intent/embed-cache.ts                  DELETED (embedding cache the classifier used)
packages/teams-bot/src/intent/add-to-training-card.ts         DELETED (writes to training_data)
```

### DELETE — Slash command handlers feeding training_data

```
packages/teams-bot/src/slash-commands/handlers/turn-label.ts  DELETED (manual label correction → training_data)
packages/teams-bot/src/slash-commands/handlers/teach.ts       DELETED (admin teaches the classifier a new pattern)
packages/teams-bot/src/slash-commands/registry.ts             MOD     (remove turn-label + teach registrations)
```

### DELETE — hr-service helm cron + queries

```
packages/hr-service/helm/templates/trace-import-cronjob.yaml  DELETED (kicks off RetrainModelWorkflow nightly)
packages/hr-service/src/db/queries/bot-intent-training-data.ts DELETED
```

### DELETE — CI build job

```
.github/workflows/build-and-push.yaml                         MOD
  - Remove 'intent-classifier' from the build matrix (line 20)
  - Remove the path filter 'packages/intent-classifier/**' (line 12)
```

### MODIFY — Workflow + worker registrations

```
packages/hr-service/src/workflows/index.ts                    MOD (remove RetrainModelWorkflow + adminApprovalSignal + types)
packages/hr-service/src/workers/temporal-worker.ts            MOD (remove `import * as classifierLifecycleActivities` + spread)
packages/teams-bot/src/langgraph/runner.ts                    MOD (remove the classify node from the graph wiring; runner goes straight from ingest → grammar → triage)
packages/teams-bot/src/langgraph/nodes/index.ts               MOD (drop classify export)
packages/hr-service/src/mcp-server/index.ts                   MOD (drop classifier-retrain tool registration)
packages/teams-bot/src/slash-commands/handlers/turn-feedback.ts MOD (rewrite — see "Preserved with rewrite" below)
```

### MODIFY — DB cleanup migration

```
packages/hr-service/src/db/migrations/045_remove_intent_classifier.sql  NEW

  -- Tunable rows (5–6 keys, exact list confirmed by grep before run)
  DELETE FROM bot_tunables WHERE key LIKE 'lg.classifier_%';

  -- Intent-classifier data tables (per user direction 2026-05-06: drop now)
  -- IF EXISTS guards the renames in slice 029; CASCADE handles any
  -- residual indexes / RLS policies / FK references.
  DROP TABLE IF EXISTS training_data        CASCADE;
  DROP TABLE IF EXISTS bot_intent_examples  CASCADE;
  DROP TABLE IF EXISTS model_runs           CASCADE;
  DROP TABLE IF EXISTS bot_turn_feedback    CASCADE;
```

```
packages/hr-service/src/db/schema.ts                                   MOD
  - Remove drizzle table definitions for the 4 dropped tables (if present)
  - Remove any related types/exports
```

### MODIFY — slice docs (mark superseded / cancelled)

```
slices/archive/SLICE_56_SKLEARN_INTENT_ROUTER.md               MOD (mark superseded by 61; keep for history)
slices/archive/SLICE_56N_TEMPORAL_RETRAIN_WORKFLOW.md          MOD (mark superseded)
slices/archive/SLICE_56*_*.md (other 56 family docs)           MOD (mark superseded; keep for history)
slices/SLICE_58H_PER_TENANT_DOC_CLASSIFIER.md                  MOD (mark CANCELLED — no doc-side classifier; LLM stays)
slices/CONTEXT_WORKFLOW.md                                     MOD (update 58H status to CANCELLED; add 61 entry)
```

---

## Hard rules

1. **Drop the data tables.** Per user direction (2026-05-06):
   `training_data`, `bot_intent_examples`, `model_runs`, `bot_turn_feedback`
   are all dropped in migration 045. No future few-shot pool will be
   mined from them. Make sure migration 045 ships in the same release
   as the code deletions so there's no transient window where the
   tables exist but no code reads/writes them.

2. **Preserve the 👍/👎 feedback UI** (verdict UI + `/turn-feedback` slash
   command). The button still appears in the response footer. The
   handler is rewritten to write a Langfuse score on the trace instead
   of (or in addition to) a `training_data` row. See "Preserved with
   rewrite" below.

3. **The bot's LangGraph runner must NOT have a classify node** after
   this slice. The graph shape becomes:

   ```
   ingest → grammar → triage → plan → execute → summarize
   ```

   Removing the classify node is a structural change; ensure the runner
   still handles the cases the classify node previously short-circuited
   (clarify, narrow_plan, disambiguation). Most of those are dead in
   shadow mode anyway since `lg.classifier_honor_decisions=false`.

4. **No new infra dependencies.** This is a removal slice; nothing new
   should be introduced. If the LLM-only path needs a small helper
   (e.g., a few-shot example block in the triage prompt), do it as a
   separate follow-up — not 61.

5. **Test before delete.** Verify `lg.classifier_enabled=false`
   everywhere first. The pod-restart test on 2026-05-06 was on a single
   tenant; deletions ride on that being correct platform-wide.

6. **Cluster pod cleanup.** After deletion + redeploy, run
   `kubectl -n cip-app delete deploy intent-classifier` to remove the
   running pod (the helm chart is gone, but the deployment object stays
   until reconciliation; explicit delete is safer).

7. **CI matrix sanity.** After removing `intent-classifier` from the
   build matrix, run a no-op push and confirm CI succeeds. The existing
   build-and-push workflow has a strategy.matrix; ensure removing one
   value doesn't break the structure.

---

## Preserved with rewrite — `/turn-feedback`

Today the handler writes to the `bot_turn_feedback` table, which is
read by the trace-import workflow as a label-correction source. Under
slice 61 the table is **dropped** (migration 045) along with the
trace-import workflow.

The new write target is **Langfuse trace scores only**:

```typescript
// packages/teams-bot/src/slash-commands/handlers/turn-feedback.ts (rewritten)

import { CallbackHandler } from '@langfuse/langchain';

export async function handleTurnFeedback(args: {
  turnId: string;
  verdict: 'positive' | 'negative';
  ctx: ResolvedContext;
}): Promise<{ reply: string }> {
  // Score the trace identified by turnId. Langfuse's API supports
  // attaching scores to traces by ID.
  await langfuseClient.score({
    traceId: args.turnId,
    name:    'turn_verdict',
    value:   args.verdict === 'positive' ? 1 : 0,
    comment: `User feedback from /turn-feedback`,
  });

  return { reply: args.verdict === 'positive' ? '👍 Recorded.' : '👎 Recorded.' };
}
```

The score becomes filterable in Langfuse: weekly review of low-scored
traces drives prompt iteration. This replaces the retrain workflow.
No DB-side feedback write — Langfuse is the only canonical store.

---

## What stays vs goes — summary table

| Component | Action | Why |
|---|---|---|
| `intent-classifier` Python package | **DELETE** | The brain we're removing |
| Helm chart + cron + deployment | **DELETE** | Infra for the brain |
| CI build for it | **DELETE** | Stops building the image |
| hr-service `classifier-lifecycle` module | **DELETE** | Retrain orchestration |
| Bot `classifier-client.ts`, `classify.ts` node | **DELETE** | Bot-side caller |
| Bot `disambiguation-card`, `clarification-templates`, `embed-cache`, `add-to-training-card` | **DELETE** | Classifier-driven UX surfaces |
| `/turn-label`, `/teach` slash commands | **DELETE** | Training-data writers (no consumer left) |
| `/turn-feedback` slash command | **KEEP, REWRITE** | Verdict UI is still useful — write to Langfuse score only |
| `lg.classifier_*` tunables (5–6 rows) | **DELETE** (migration 045) | Disabled config |
| `training_data` table | **DROP** (migration 045) | User direction 2026-05-06 — full cleanup |
| `bot_intent_examples` table | **DROP** (migration 045) | Per slice 029 may already be renamed; IF EXISTS guards |
| `model_runs` table | **DROP** (migration 045) | Audit trail of the deleted system; not preserved |
| `bot_turn_feedback` table | **DROP** (migration 045) | New `/turn-feedback` writes to Langfuse only |
| Slice 56 family docs | **MARK SUPERSEDED** | Keep for history |
| Slice 58H | **MARK CANCELLED** | This slice cancels the plan |

---

## Workflow registration cleanups

```typescript
// packages/hr-service/src/workflows/index.ts — REMOVE these blocks:

// Slice 56N: classifier model lifecycle. Replaces the slice-56C cron…
export {
  RetrainModelWorkflow,
  adminApprovalSignal,
  stepQuery,
} from '../modules/classifier-lifecycle/workflows/retrain-model.workflow.js';
export type {
  RetrainModelWorkflowInput,
  RetrainModelWorkflowOutput,
  AdminApprovalSignalPayload,
} from '../modules/classifier-lifecycle/workflows/retrain-model.workflow.js';
```

```typescript
// packages/hr-service/src/workers/temporal-worker.ts — REMOVE:

import * as classifierLifecycleActivities from '../modules/classifier-lifecycle/activities/index.js';
// …
activities: {
  ...certActivities,
  ...employeeActivities,
  ...classifierLifecycleActivities,   // REMOVE this line
  ...maintenanceActivities,
},
```

```typescript
// packages/teams-bot/src/langgraph/runner.ts — REMOVE:

import { classifyNode } from './nodes/classify.js';   // REMOVE
// …
graph.addNode('classify', classifyNode);              // REMOVE
graph.addEdge('grammar', 'classify');                 // REPLACE → addEdge('grammar', 'triage')
graph.addEdge('classify', 'triage');                  // REMOVE
```

(Exact line numbers will shift; the implementer reads the current
runner and removes the classify node + reconnects edges so triage
runs after grammar.)

---

## Acceptance criteria

1. **`pnpm -r run typecheck` is clean** after all deletions and
   modifications. No dangling imports.

2. **Bot starts and serves turns**. Test with a tool query
   ("show my certs") and a chitchat ("hi"). Both should respond.
   Latency comparable to current LLM-only path measurements (~1–2s
   tool, ~3s direct).

3. **CI builds 4 services, not 5.** `gh workflow view "Build and Push Images"`
   shows hr-service, platform-core, teams-bot, document-service in
   the matrix. No intent-classifier.

4. **`kubectl -n cip-app get deploy`** does NOT list `intent-classifier`.

5. **`grep -rn "classifier-client\|classifierLifecycle\|RetrainModelWorkflow\|callClassifier" packages/`** returns zero matches in `src/`.

6. **`/turn-feedback` still works.** Click 👍 on a turn → Langfuse trace
   gets a score of 1. Click 👎 → score of 0. Verify in Langfuse UI.

7. **`bot_tunables` no longer has `lg.classifier_*` rows.** Migration
   045 ran; `SELECT key FROM bot_tunables WHERE key LIKE 'lg.classifier_%'`
   returns zero.

8. **Data tables dropped.** `\d training_data` in psql returns
   "Did not find any relation named...". Same for `bot_intent_examples`,
   `model_runs`, `bot_turn_feedback`. No drizzle code references them.

9. **`gh workflow list`** shows neither `Cluster startup (morning)`
   active (already disabled) nor any classifier-related workflow.

10. **CONTEXT_WORKFLOW.md** has slice 58H marked CANCELLED and a slice
    61 row.

---

## Test plan

- **Unit**: any tests in `packages/hr-service/test` referencing
  classifier-lifecycle activities → deleted alongside the source.
- **Integration**: a smoke test of the LangGraph runner (current ones
  may exercise the classify node — update or remove).
- **Manual**: 5 representative bot turns post-deploy:
  1. "what are my roles?" — expects `get_employee_permissions`, ~1.5s
  2. "show me the team" — expects `employee_list`, ~1.5s
  3. "hi" — direct chitchat, current ~3s (separate optimization)
  4. File upload — orthogonal path, unchanged
  5. Ambiguous: "the cert thing" — LLM clarifies via prompt (no more
     disambiguation card from classifier)
- **Langfuse**: 👍/👎 click on (1) records a score; visible in trace.
- **Cluster**: confirm no `intent-classifier-*` pods. Confirm no
  helm release `intent-classifier`.

---

## Rollback

If something breaks post-deploy:

1. **Soft rollback** (keep deletions, restore behavior): re-flip
   `lg.classifier_enabled=true` won't help — there's nothing to call.
   The only soft rollback is reverting the bot's runner change to
   re-add the classify node and re-deploying.
2. **Hard rollback**: `git revert` the slice 61 commit. Deleted files
   come back. Re-deploy. Helm chart for intent-classifier reapplies on
   next deploy. The classifier pod doesn't auto-recreate from the
   helm template — you'd need to re-run helm install for it.

The slice is significant code deletion (~3000+ LOC across multiple
packages). The data tables are preserved deliberately — those are the
valuable long-term artifact.

---

## Operational sequence (deploy day)

1. Confirm `lg.classifier_enabled=false` for ALL tenants (not just
   `00...001`):
   ```sql
   UPDATE bot_tunables
      SET value_json = 'false'
    WHERE key IN ('lg.classifier_enabled', 'lg.classifier_honor_decisions');
   ```
2. Wait one tunables-cache TTL (5 min) or restart bot.
3. Smoke-test bot — confirm LLM-only path is healthy across tenants.
4. Merge slice 61 PR.
5. CI builds 4 services (was 5). Image pushed.
6. Deploy bot, hr-service. (`kubectl set image` per the patterns we've
   used.)
7. Run migration 045 (drops the tunable rows AND the 4 data tables).
8. `helm uninstall intent-classifier --namespace cip-app` (or whatever
   the release name is).
9. `kubectl -n cip-app delete deploy intent-classifier` (belt + suspenders).
10. Wait an hour. Watch for any unexpected behaviors. Confirm Langfuse
    scores landing from 👍/👎 clicks.
11. Update CONTEXT_WORKFLOW.md slice 58H status to CANCELLED.

---

## Forward refs

- **Slice 58H is formally cancelled** by 61. The document classifier
  stays LLM-only. If document classify cost ever becomes a measurable
  problem at scale, a future slice would build a sklearn fast-path —
  but as a *cost optimization tool*, not as the brain.
- **Slice 60 (eval harness)** generalizes after 61. The
  `eval_recent_reclassifications` MCP tool's data source becomes
  Langfuse low-scored traces. No `training_data` table to read.
- **Slice 58F-Lite (reclassify)** still ships independently — it's a
  doc-side feedback signal (writes to Langfuse + `audit_events`), not
  a classifier-side training data write.
- **No few-shot pool from data tables** — they're dropped. If we ever
  want few-shot iteration, the source becomes Langfuse-scored traces:
  filter for highly-rated traces in a domain, copy into the prompt as
  examples. Manual or scripted; doesn't need a custom DB.

---

## Estimated scope

- **Deletions**: ~3000 LOC across `intent-classifier/`, `classifier-lifecycle/`, bot `intent/` files, slash command handlers
- **Modifications**: ~10 files (workflow registry, worker, runner, slash registry, CI yaml, slice docs)
- **New code**: ~30 LOC (rewritten `turn-feedback` handler) + 1 small migration
- **Net**: solidly negative LOC. ~30:1 ratio of deleted to added code.
- **Risk**: medium — touches the bot's hot path (LangGraph runner).
  Mitigated by the prior smoke-test on the production tenant with
  classifier disabled, which proved the LLM-only path works.
- **Effort**: ~1–2 days of focused work + 1 day of monitoring after deploy.
