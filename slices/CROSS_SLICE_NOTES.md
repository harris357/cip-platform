# CIP Platform — Cross-Slice Notes

> **Purpose:** When a session reveals that an earlier slice needs a fix, it is logged here
> rather than fixed immediately. Cross-slice fixes are batched and applied using
> `PROMPT CROSS-SLICE` from `PROMPTS_ALL.md` before the next slice begins.
>
> **Format:** Copy the template below. Set status to OPEN when logged, RESOLVED when fixed.

---

## Template

```
### CS-NNN
- **Logged in:** Slice NN (name)
- **Affects:** Slice NN (name)
- **File:** packages/.../src/...
- **Status:** OPEN
- **Issue:** One sentence describing what is wrong.
- **Why it matters:** Which downstream slices or runtime behaviours break if not fixed.
- **Fix:** Exact change required — field to add, type to correct, function to rename, etc.
```

---

## Open Notes

### CS-002 — RESOLVED 2026-04-24
- **Logged in:** Cross-slice session (2026-04-24)
- **Affects:** `packages/platform-core`
- **File:** `packages/shared/src/types/events.ts`
- **Status:** RESOLVED 2026-04-24
- **Issue:** `packages/platform-core/src/activities/provision-complete-notify.activity.ts` imports `TenantProvisionedEvent` from `@cip/shared/src/types/events.js` but that export did not exist.
- **Fix applied:** Added `TenantProvisionedEvent { tenantId, tenantName, provisionedAt }` to `packages/shared/src/types/events.ts`.

### CS-003 — RESOLVED 2026-04-24
- **Logged in:** Cross-slice session (2026-04-24)
- **Affects:** `packages/platform-core`
- **File:** `packages/shared/src/types/workflow.ts`
- **Status:** RESOLVED 2026-04-24
- **Issue:** `TenantProvisioningWorkflow` accessed `input.tier` and `input.budgetLimitUsd` but `TenantProvisioningInput` lacked those fields.
- **Fix applied:** Added `tier: 'standard' | 'premium' | 'enterprise'` and `budgetLimitUsd: number` to `TenantProvisioningInput`. Union type matches the constraint in `issueLiteLLMVirtualKey` activity.

### CS-004
- **Logged in:** Cross-slice session (2026-04-24)
- **Affects:** `packages/hr-service`
- **File:** `packages/shared/src/types/agent.ts`
- **Status:** OPEN
- **Issue:** `ExtractionResult` is declared in `agent.ts` but not exported; five `hr-service` files fail to import it (`notify-hitl.activity.ts`, `persist-cert.activity.ts`, `run-vision-agent.activity.ts`, `validate-extraction.activity.ts`, `agents/vision-agent/index.ts`).
- **Why it matters:** `hr-service` typecheck fails completely; all cert-processing activities and the vision agent cannot compile.
- **Fix:** Export `ExtractionResult` from `packages/shared/src/types/agent.ts` (add `export` keyword or re-export from the existing declaration).

### CS-005
- **Logged in:** Cross-slice session (2026-04-24)
- **Affects:** `packages/hr-service`
- **File:** `packages/shared/src/types/workflow.ts`
- **Status:** OPEN
- **Issue:** `HITLDecisionSignal` is imported by `hr-service/src/activities/persist-cert.activity.ts` and `hr-service/src/workflows/certification-processing.workflow.ts` but does not exist in `workflow.ts`.
- **Why it matters:** `hr-service` typecheck fails; the HITL signal/handler in the certification workflow cannot compile.
- **Fix:** Add and export `HITLDecisionSignal` to `packages/shared/src/types/workflow.ts`. Shape must satisfy what `persist-cert.activity.ts` and `certification-processing.workflow.ts` expect (review both files to derive the exact shape before adding).

### CS-006
- **Logged in:** Cross-slice session (2026-04-24)
- **Affects:** `packages/hr-service`
- **File:** `packages/shared/src/types/events.ts`
- **Status:** OPEN
- **Issue:** `hr-service/src/nats/watcher.ts` imports `CertificationUploadedEvent` and `WorkerAllocatedToSiteEvent` from `events.ts`, but neither is defined there.
- **Why it matters:** `hr-service` NATS watcher cannot compile; no cert-upload or worker-allocation events can be consumed.
- **Fix:** Add and export `CertificationUploadedEvent` and `WorkerAllocatedToSiteEvent` to `packages/shared/src/types/events.ts`. Read `watcher.ts` first to derive the exact shape expected for each type.

### CS-007
- **Logged in:** Cross-slice session (2026-04-24)
- **Affects:** `packages/hr-service`
- **File:** `packages/shared/src/types/agent.ts` and `packages/shared/src/types/workflow.ts`
- **Status:** OPEN
- **Issue:** Two groups of errors in `hr-service`:
  1. `VisionAgentState` is missing the field `userId` (used in `agents/vision-agent/index.ts` line 40).
  2. `CertProcessingInput` is missing the fields `objectStoreKey` and `certificationId` (used in `certification-processing.workflow.ts` at multiple lines).
- **Why it matters:** `hr-service` typecheck fails; the vision agent and certification workflow cannot compile.
- **Fix:**
  1. Add `userId: string` to `VisionAgentState` in `packages/shared/src/types/agent.ts`.
  2. Add `objectStoreKey: string` and `certificationId: string` to `CertProcessingInput` in `packages/shared/src/types/workflow.ts`.

---

## Resolved Notes

### CS-001 — RESOLVED 2026-04-24
- **Logged in:** Slice 02 (Shared Types)
- **Affects:** scaffold utils (tenant-context.ts)
- **File:** `packages/shared/src/utils/tenant-context.ts`
- **Status:** RESOLVED 2026-04-24
- **Issue:** `systemRole` was removed from `TenantContext` but the middleware still extracted it from the JWT and used it to build the context object. `tenantConfig: TenantConfig` (now required) was missing entirely.
- **Fix applied:** Removed `systemRole` extraction; added a stub `tenantConfig` built from JWT `tenantId` + env vars (`KEYCLOAK_REALM`). Hydration from DB/cache is deferred to the tenant-config service slice.

---

## Patterns to Watch For

These are the cross-slice issues that occur most often in this codebase,
based on the architecture's known coupling points.

### `@cip/shared` types are too narrow (Slices 02 → 06, 07, 09, 10, 11)

The most common issue. `VisionAgentState`, `ExtractionResult`, `CertProcessingInput`
and similar types are defined in Slice 02 but not fully exercised until Slice 06 or 07.
Fields that seem optional at definition time turn out to be required by the time
an Activity or LangGraph node tries to use them.

**Watch for:** TypeScript errors in later slices referencing `@cip/shared` types with
messages like "Property X does not exist" or "Type undefined is not assignable to string."

**Resolution pattern:** Add the field to the type in `packages/shared/src/types/`,
re-run `pnpm --filter @cip/shared typecheck`, then re-run typecheck on the affected service.

---

### Subject builder missing an event (Slices 03 → 08, 09, 11)

`subject-builder.ts` defines `Subjects.certUploaded`, `Subjects.certProcessed` etc.
in Slice 03. Later slices (NATS Watcher in 08, cert-upload handler in 11) may
need subjects not yet defined there.

**Watch for:** A slice prompt forcing you to write a raw NATS subject string because
the `Subjects.*` helper doesn't exist yet.

**Resolution pattern:** Add the helper to `subject-builder.ts` and re-export it from
`packages/shared/src/index.ts`. This is a safe additive change that doesn't break
any existing slice.

---

### Zod schema doesn't match the TypeScript type (Slices 03 → 06, 07)

`zod-schemas.ts` in Slice 03 defines `ExtractionResultSchema`. If the TypeScript
`ExtractionResult` interface in Slice 02 changes shape, the Zod schema falls out of sync.
This won't always produce a TypeScript error — it produces a runtime validation failure.

**Watch for:** An Activity that calls `.parse()` and the Zod schema rejects a value
that the TypeScript type says should be valid. Also watch for a Zod schema that accepts
values the TypeScript type has marked as optional but should be required (or vice versa).

**Resolution pattern:** Update `zod-schemas.ts` to match the TypeScript type exactly.
Consider using `z.infer<typeof Schema>` as the TypeScript type to keep them in sync
automatically — if you do this, update the type in `@cip/shared/types/` to re-export
the Zod-inferred type instead of a hand-written interface.

---

### Helm values don't reference the right K8s secret name (Slices 04 → 06, 10, 11, 12)

K8s secret names are established in Slice 00-B (Platform Readiness) and encoded
in `scripts/create-secrets.sh`. Slice 04 writes Helm values files. Later slices
add Helm charts for each service. If any of these use a different secret name from
what `create-secrets.sh` creates, the pod fails to start with a `SecretNotFound` error.

**Watch for:** A Helm `deployment.yaml` that references `secretKeyRef.name: some-secret`
where `some-secret` doesn't match any name in `create-secrets.sh`.

**Resolution pattern:** Cross-check every `secretKeyRef.name` in every Helm template
against the secret names in `create-secrets.sh`. The canonical list is in `CLAUDE.md`
(the seven secrets created in Slice 00-B's K8s section).

---

### Temporal task queue name mismatch (Slices 03 → 06, 10, 12)

`TEMPORAL_TASK_QUEUE_HR` and `TEMPORAL_TASK_QUEUE_PLATFORM` are set as env vars
in `.envrc` and K8s secrets. The Temporal worker in each service reads from these.
If a workflow `start()` call uses a hardcoded string instead of the env var,
the workflow will be dispatched to a queue that no worker is polling.

**Watch for:** Any `taskQueue: 'cip-hr-tasks'` or similar hardcoded string outside
of the env var reference `process.env['TEMPORAL_TASK_QUEUE_HR']`.

**Resolution pattern:** Replace every hardcoded task queue string with
`process.env['TEMPORAL_TASK_QUEUE_HR'] ?? 'cip-hr-tasks'` (env var with fallback).

---

### `tenantId` dropped at a boundary (any slice)

The most insidious cross-slice concern. `tenantId` flows correctly through one layer
then gets dropped at a handoff — typically where a plain object is constructed instead
of spread from an existing typed value.

**Watch for:**
- An Activity input that is constructed with `{ certId, documentUrl }` missing `tenantId`
- A NATS event payload that is `JSON.stringify({ certId, status })` with no `tenantId`
- An agent state that is initialised with `{ runId, startedAt }` and `tenantId` added only
  as an afterthought, or not at all

**Resolution pattern:** For every object construction that produces a domain type,
check the resulting object against the type definition and confirm `tenantId` is present.
TypeScript strict mode catches most but not all of these (it won't catch a `string` being
passed where `string` is expected but the *value* is wrong or empty).
