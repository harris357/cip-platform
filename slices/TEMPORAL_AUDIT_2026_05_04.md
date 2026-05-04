# Temporal Workflow Audit — CIP Platform

> **Date:** 2026-05-04
> **Trigger:** User request after slice 56N — "do a deep dive done of
> the entire app again to make sure we aren't missing any other places
> where we can get value from durable workflow."
> **Method:** Research agent ran a systematic sweep over Helm CronJobs,
> scripts, MCP tools, NATS consumers, and multi-step orchestration.

## Executive summary

- **One live bug found:** `ComplianceDriftCheckWorkflow` is referenced
  but doesn't exist. Every `cert.expired` NATS event silently fails.
  This is the highest-leverage fix and the next slice to ship.
- **Two CronJobs remain unmodernized** (checkpoint-gc, trace-import) —
  candidates for follow-up but not breaking anything today.
- **One large bash script** (`scripts/provision-tenant.sh`, 562 lines)
  duplicates an underbuilt Temporal workflow. Operators run the bash;
  the workflow is a stub.
- **Two MCP tools** do multi-system writes without compensating actions
  (`employee_assign_role`, `employee_revoke_role`).
- **The audit explicitly approved many things as-is** — `sync_employee`
  is correctly latency-sensitive and stays sync; bootstrap.sh and
  diagnostic scripts stay as operator commands.

## High-priority candidates

### 57A — `ComplianceDriftCheckWorkflow` (LIVE BUG)

**Where:** `packages/hr-service/src/nats/watcher.ts:129-137`

The handler calls `client.workflow.start('ComplianceDriftCheckWorkflow', …)`
for every `cert.expired` JetStream event, but **the workflow is not
defined anywhere in the repo**. No file under
`modules/certifications/workflows/`. No export from
`workflows/index.ts`. The worker can't resolve the workflow type, the
consumer `nak()`s, the message is redelivered, fails again forever.

NATS stream `CERTS` has 365-day retention (per `bootstrap.sh:96`),
so the backlog can grow large.

**What goes wrong:** Cert-expiry → no employee notification, no
HR escalation, no remediation. The TODO comment at `watcher.ts:125`
also hints at unimplemented expiry-reminder logic for certs that are
about to expire.

**Effort:** Medium. Workflow + ~3 activities + 1 signal.

**Pattern to emulate:** `CertificationProcessingWorkflow`'s
signal-wait-with-timeout structure (`hitlDecisionSignal` +
`condition()`). Both this expiry workflow and the cert-processed
reminder logic could share a workflow class.

### 57B — Replace `checkpoint-gc` cron with Temporal Schedule

**Where:** `packages/hr-service/helm/templates/checkpoint-gc-cronjob.yaml`
runs `node dist/scripts/gc.js` daily at 03:30 UTC. Three sequential
DELETEs (`trimCheckpoints`, `trimCheckpointWrites`, `trimMetrics`).

**Why Temporal:**
- Each DELETE becomes its own activity with retry — second isn't
  blocked by transient issues on first.
- Temporal Schedule replaces K8s CronJob — admin can pause / kick off
  ad-hoc / see history.
- Establishes the Schedule pattern in the codebase (no Temporal
  Schedule exists today).

**Effort:** Small. Three activities + one workflow + one Schedule.

**Priority:** Medium-high. Operational improvement, not bug fix.

## Medium-priority candidates

### 57C — Fold `trace-import` cron into `RetrainModelWorkflow`

**Where:** `packages/intent-classifier/helm/templates/trace-import-cronjob.yaml`
runs Saturdays at 02:00 UTC. The work it does is **already a step**
in `RetrainModelWorkflow` (slice 56N) — `importTracesActivity`.

**Fix:** Add a `mode: 'import-only'` input flag to
`RetrainModelWorkflow` that bails after the import step. Replace the
CronJob with a Temporal Schedule pointing at the workflow with
that mode.

**Effort:** Small. One input flag + one schedule. Trivial after 57B
establishes the Schedule pattern.

### 57D — `EmployeeRoleChangeWorkflow` (assign + revoke)

**Where:** `packages/hr-service/src/modules/employees/mcp-tools/employee.assign-role.tool.ts:62-103`
and `employee.revoke-role.tool.ts`.

**What's wrong:** Sync handler does Postgres tx → KC GET → KC POST →
audit INSERT. If the pod dies between KC POST and audit INSERT, KC
has the role mapping but `hr_actions` shows nothing. Narrow race but
real.

**Pattern to emulate:** `EmployeeDisableWorkflow` — MCP tool kicks
workflow, returns `workflowId` immediately, KC mutation + audit are
both activities.

**Effort:** Small. One workflow with `assign|revoke` mode parameter.

### 57E (large) — `scripts/provision-tenant.sh` → full `TenantProvisioningWorkflow`

**Where:** `scripts/provision-tenant.sh` (562 lines) vs. the 40-line
stub at `packages/platform-core/src/workflows/tenant-provisioning.workflow.ts`.

The bash script does what the workflow's activities are supposed to
do, plus AAD federation, per-tenant K8s Secret writes,
`tenant_identity_providers` UPDATE, and admin-email elevation —
none of which exist as workflow activities.

**Effort:** Large. ~4 new activities, expanded workflow body, a CLI
shim that lets `provision-tenant.sh` call `temporal workflow start`
during the migration period.

**Status (2026-05-04):** **Deferred — intentionally unshipped.**

A first attempt during this same session added structural skeletons
(3 stub activities throwing "not implemented", workflow wired to call
them, bash `--use-workflow` flag) but was **reverted before commit**
because:
- Activity bodies need genuine porting from bash (KC IDP API calls,
  kubectl secret create, DB UPDATEs, role assignment) — not stubs.
- Half-shipped, the workflow path would advertise functionality that
  throws at runtime, which is a worse state than the all-bash status
  quo.
- The audit's own recommendation was to defer until other 57x slices
  stabilise AND a dedicated implementation session is available. We
  honoured that.

**When to revisit:** once 57B + 57C are running in production for
2-3 weeks AND an operator wants to drive tenant provisioning from a
non-bash entry point (UI, admin bot command, automated provisioning
hook). The 4 missing activity bodies + return-the-secrets refactor of
`createKeycloakRealm` are the deliverable.

## What's correctly NOT a Temporal candidate

The audit explicitly approved these as-is:

- `sync_employee` MCP tool — every bot turn, latency-sensitive, idempotent
- `bootstrap.sh` and other operator-run scripts — diagnostic, not orchestration
- `langfuse-cost.ts`, `fetchTraceCost`, `fetchSessionCost` — sync UI render with timeouts
- `langgraph/runner.ts` typing-indicator setInterval — sub-turn lifecycle
- `scale-nodepool.ts` OVH polling — operator-driven
- `training-data-*.sh` scripts — single-DB-query wrappers

## Recommended ship order

| Slice | What | Effort | Status (2026-05-04) |
|---|---|---|---|
| **57A** | ComplianceDriftCheckWorkflow (BUG FIX) | Medium | Deferred — workflow stub already in place; user opted to address later |
| **57B** | CheckpointGCWorkflow + Temporal Schedule | Small | ✅ Shipped |
| **57C** | trace-import folded into RetrainModelWorkflow | Small | ✅ Shipped |
| **57D** | EmployeeRoleChangeWorkflow | Small | Deferred — user opted to address later (stubbed for review) |
| **57E** | TenantProvisioningWorkflow (full) | Large | Deferred — first attempt reverted; properly defer |

## Patterns the audit identified for reuse

Implementers should crib from these:

- **Signal + condition-with-timeout:** `certification-processing.workflow.ts:24,41`
  and `retrain-model.workflow.ts:46-47,156-161`
- **Compensating action on partial failure:** `retrain-model.workflow.ts:228-256`
- **MCP tool → workflow.start handoff:** `process-document.ts:61-68`
- **Activity proxy with per-step timeouts:** `retrain-model.workflow.ts:56-80`
- **Worker registration:** `packages/hr-service/src/workers/temporal-worker.ts`
  — add new activity modules to the spread

## Audit methodology (for next time)

The agent ran systematic sweeps over:
- All Helm CronJob templates (`find … -name "*.yaml" -path "*templates*" | xargs grep -l "kind: CronJob"`)
- `scripts/` directory (multi-step bash chains)
- All MCP tools (multi-network-call handlers)
- NATS consumers (event-driven workflow starters)
- Long-running async operations
- Human-in-the-loop patterns

Re-run quarterly or after major slice families. Save findings as
SLICE_TEMPORAL_AUDIT_YYYY_MM_DD.md.
