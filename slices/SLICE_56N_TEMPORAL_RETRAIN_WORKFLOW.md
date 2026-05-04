# Slice 56N — model lifecycle as a Temporal workflow

> **Why this exists:** The slice 56C cron-bash chain (skip-check →
> export → eval → train → upload → DB lineage → membership) is
> 7+ steps with discrete failure modes, async DB writes, and an
> implicit human review step that's tracked by no system. This slice
> moves it onto Temporal — the same infrastructure already used for
> tenant provisioning, employee identity sync, and certification
> processing — giving us durability, observability, signal-paused
> admin review, and compensating actions on partial failure.

---

## What changes

```
Before (slice 56C):
  CronJob → cron_entrypoint.sh → bash chain → ...
    │ no admin-review step (admin runs `make training-data-mark-reviewed` ad-hoc)
    │ if step 5 fails after step 4 succeeded, you re-run from scratch
    │ if S3 upload succeeds and DB lineage fails, you have inconsistent state
    │ no observability beyond pod logs

After (slice 56N):
  Trigger (MCP tool OR cron — see "Triggers" below)
    ↓
  RetrainModelWorkflow (durable, observable in Temporal Web UI):
    ├─ importTracesActivity                  (retry on Langfuse 5xx)
    ├─ countUnreviewedRowsActivity
    ├─ notifyAdminReviewPendingActivity
    ├─ ▼ wait for adminApprovalSignal ▼      (durable pause; survives pod restart)
    ├─ exportTrainingDataActivity
    ├─ trainModelActivity                    (30-min timeout, no retry)
    ├─ evalModelActivity                     (regression gate; abort on fail)
    ├─ uploadModelToS3Activity
    ├─ recordModelRunActivity                (compensates: delete S3 on later failure)
    ├─ recordTrainingMembershipActivity
    └─ verifyHotReloadActivity               (poll /healthz; non-fatal if exceeded)
```

---

## Files in scope

```
packages/hr-service/src/db/migrations/
  └── 036_model_runs_workflow_id.sql                                    NEW

packages/hr-service/src/modules/classifier-lifecycle/                   NEW directory
  ├── workflows/
  │     └── retrain-model.workflow.ts                                   NEW
  ├── activities/
  │     ├── index.ts                                                    NEW
  │     ├── trace-import.activity.ts                                    NEW
  │     ├── notify-admin-review.activity.ts                             NEW
  │     ├── run-trainer-script.activity.ts                              NEW
  │     ├── model-promotion.activity.ts                                 NEW
  │     └── record-lineage.activity.ts                                  NEW
  └── mcp-tools/
        └── classifier-retrain.tool.ts                                  NEW

packages/hr-service/src/workflows/index.ts                              MOD (export RetrainModelWorkflow)
packages/hr-service/src/workers/temporal-worker.ts                      MOD (register classifier-lifecycle activities)
packages/hr-service/src/modules/admin/mcp-tools/index.ts                MOD (register the two new MCP tools)
packages/hr-service/src/db/queries/bot-intent-training-data.ts          MOD (addModelRun accepts workflowId)

packages/intent-classifier/src/admin_api.py                             NEW (FastAPI router with /admin/run-* endpoints)
packages/intent-classifier/src/main.py                                  MOD (include the admin router)

packages/intent-classifier/helm/templates/trainer-cronjob.yaml          MOD (deprecation comment; behavior unchanged for back-compat)
```

---

## Architecture decisions

### Why HTTP shims to the Python scripts (not re-implement in TS)

The trainer + import logic lives in Python (sklearn, joblib, Langfuse
SDK). The Temporal worker is in TypeScript. Two options:

1. **Re-implement train/eval/upload in TS** — duplicates 600+ lines of
   ML logic. Two sources of truth. Drift risk. Rejected.
2. **HTTP shims**: TS activity → POST to intent-classifier
   `/admin/run-*` endpoint → Python subprocess → return JSON. Single
   source of truth (Python). Activity layer gives Temporal observable,
   retriable wrappers. **Picked.**

Subprocess boundary inside the classifier service is intentional —
isolates the long-running training process from the HTTP request
thread. If train hangs, the activity's `startToCloseTimeout` fires
without taking down the classifier service.

### Why activities run as TS (not directly Python)

Temporal supports Python workers, but adding one requires:
- A second worker pod
- A Python-side workflow definition
- Cross-language signal/query coordination

Sticking with the TS worker (already deployed for hr-service) and
HTTP-shimming the Python work is cleaner. If the Python side grows
beyond the 5 endpoints here, revisit.

### Signal-based admin review

`adminApprovalSignal({approvedRowIds, note})` is the canonical
"wait for human" pattern in Temporal. The workflow blocks indefinitely
(or until `adminReviewTimeoutHours`, default 30 days) for the signal.
Survives pod restarts. Visible in Temporal UI as
"awaiting-admin-review."

`approvedRowIds` is currently advisory — admins still mark rows
reviewed=true via `make training-data-mark-reviewed` before sending
the signal. v2 can move the relabeling INTO the workflow (signal
payload becomes structured row-by-row decisions).

### Compensating actions on partial failure

```
upload to S3 → succeeded
record_model_run DB INSERT → FAILED
   ↓ compensating: delete S3 artifact (idempotent — no-op on missing key)
   ↓ workflow throws ApplicationFailure(type='lineage_recording_failed')
```

Without this, a partial run leaves an orphan S3 object that the
classifier pods would happily download (because CURRENT.json points
at it) but no DB row records its lineage. The compensating delete
keeps state consistent.

---

## Triggers

Two paths to start a RetrainModelWorkflow:

| Path | When | How |
|---|---|---|
| **MCP tool: `bot_classifier_retrain`** | Admin-fired via Teams (`/teach`-style) or programmatically | `bot_classifier_retrain { scope: 'tenant'\|'platform' }` returns the workflow id |
| **Cron** (deferred to follow-up) | Scheduled weekly | New `intent-classifier-retrain-trigger` CronJob using temporal-cli or Python SDK to start the workflow. **Not in this slice** — current 56C cron-bash chain remains as fallback for back-compat. The audit slice (56-AUDIT) will identify whether to fully replace 56C's CronJob with a workflow trigger. |

---

## Migration strategy

1. **Deploy 56N** — workflow + activities + MCP tools land. Existing
   56C cron-bash chain remains active (back-compat). Two retrain paths
   coexist.
2. **Verify 56N path** by triggering `bot_classifier_retrain` manually,
   sending the approval signal, watching the workflow complete in
   Temporal UI.
3. **Disable 56C cron** when ops is comfortable: set
   `trainer.enabled=false` in values.yaml.
4. **Add cron→workflow trigger** as a follow-up slice once we've seen
   the workflow path work in production for a couple of weeks.

---

## What this enables (immediate)

- **`make classifier-retrain-now`** can be replaced by
  `bot_classifier_retrain` (admin-fired via the bot, end-to-end). The
  bash + kubectl-job approach was a workaround for not having a
  durable workflow.
- **Admin review is now an explicit pipeline step**, not a
  best-practices document. The workflow won't proceed until the signal
  is sent.
- **Per-tenant retrain fan-out** is one line away: parent workflow
  iterates tenants, starts a child workflow per tenant. Today's
  cron-script approach would need a custom orchestration layer.
- **Workflow id ↔ model run** mapping (`bot_intent_model_runs.workflow_id`)
  lets ops correlate Temporal UI runs with DB-recorded models.

---

## What this doesn't do (yet)

- **Cron-triggered workflow start.** Today the cron still runs the
  bash chain; explicit `bot_classifier_retrain` triggers the workflow.
  Follow-up slice will replace the cron's job command with a
  workflow-starter.
- **Move admin row-marking into the workflow.** v1: admin marks
  rows reviewed=true ad-hoc, then sends signal. v2: signal payload is
  structured (per-row approve/reject) and the workflow does the
  marking.
- **Full notification surface.** v1: `notifyAdminReviewPendingActivity`
  logs to pod stdout + Temporal UI. v2: posts to Teams via the bot's
  adaptive-card mechanism.
- **Per-tenant fan-out.** The data model supports it; the workflow
  could start child workflows. Not exercised in v1.

---

## Hard rules carried forward

- **No turn fails because of the workflow.** Workflow failures don't
  affect serving traffic — the live model in S3 keeps serving until
  the next workflow promotes a new one.
- **Eval gate before promotion.** Workflow honors the same gate the
  56J cron does (≥1pp macro-F1, ≤5pp per-class regression).
- **Admin review required for `reviewed=false` rows.** The signal IS
  the review approval — the workflow will not proceed without it.
- **Tenant scoping non-negotiable.** Per-tenant runs filter every DB
  query by tenant_id; platform runs are explicitly tenantId=null.
- **Idempotent activities.** `addModelRun` uses ON CONFLICT;
  `recordTrainingMembership` uses ON CONFLICT; uploadToS3 is naturally
  idempotent (PUT same key); `verifyHotReloadActivity` polls until
  deadline.
