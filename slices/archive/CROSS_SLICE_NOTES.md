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

---

## Resolved Notes

### CS-011 — RESOLVED 2026-04-24
- **Logged in:** Cross-slice session (2026-04-24)
- **Affects:** `packages/platform-core`
- **File:** `packages/shared/src/clients/nats.ts`
- **Status:** RESOLVED 2026-04-24
- **Fix applied:** Added `export const sc = StringCodec()` and `export async function getNatsConnection(): Promise<NatsConnection>` (lazy singleton pattern) to `nats.ts`. Imported `StringCodec` from `nats`.

### CS-012 — RESOLVED 2026-04-24
- **Logged in:** Cross-slice session (2026-04-24)
- **Affects:** `packages/platform-core`
- **File:** `packages/shared/src/utils/subject-builder.ts`
- **Status:** RESOLVED 2026-04-24
- **Fix applied:** Added `tenantProvisioned: (tenantId: string) => buildSubject({ tenantId, domain: 'tenant', event: 'provisioned' })` to the `Subjects` constant.

### CS-013 — RESOLVED 2026-04-24
- **Logged in:** Cross-slice session (2026-04-24)
- **Affects:** `packages/platform-core`
- **File:** `packages/platform-core/src/server.ts`
- **Status:** RESOLVED 2026-04-24
- **Fix applied:** Replaced `import { withTenantContext }` with `import { tenantAuthMiddleware }` and replaced `app.use(withTenantContext as express.RequestHandler)` with `app.use(tenantAuthMiddleware)`. `tenantAuthMiddleware` already has the correct Express `(req, res, next)` signature.

### CS-014 — RESOLVED 2026-04-24
- **Logged in:** Cross-slice session (2026-04-24)
- **Affects:** `packages/teams-bot`
- **File:** `packages/teams-bot/src/agents/intent-router/index.ts`
- **Status:** RESOLVED 2026-04-24
- **Fix applied:** Replaced `createLiteLLMClient('cip-lightweight')` with `createLiteLLMClient({ tenantId, virtualKey: process.env['LITELLM_VIRTUAL_KEY'] ?? '' })`. The `'cip-lightweight'` alias is a model name passed at call time, not a client option.

### CS-004 — RESOLVED 2026-04-24
- **Logged in:** Cross-slice session (2026-04-24)
- **Affects:** `packages/hr-service`
- **File:** `packages/shared/src/types/agent.ts`
- **Status:** RESOLVED 2026-04-24
- **Fix applied:** Added `export type { ExtractionResult }` re-export to `agent.ts`. Note: resolving this export revealed a deeper shape mismatch (logged as CS-008).

### CS-005 — RESOLVED 2026-04-24
- **Logged in:** Cross-slice session (2026-04-24)
- **Affects:** `packages/hr-service`
- **File:** `packages/shared/src/types/workflow.ts`
- **Status:** RESOLVED 2026-04-24
- **Fix applied:** Added and exported `HITLDecisionSignal { approved: boolean; correctedFields?: Record<string, string>; reviewedBy: string; reviewedAt: string }` to `workflow.ts`. Shape derived from `persist-cert.activity.ts` and `certification-processing.workflow.ts`.

### CS-006 — RESOLVED 2026-04-24
- **Logged in:** Cross-slice session (2026-04-24)
- **Affects:** `packages/hr-service`
- **File:** `packages/shared/src/types/events.ts`
- **Status:** RESOLVED 2026-04-24
- **Fix applied:** Added `CertificationUploadedEvent { tenantId, workerId, certificationId, objectStoreKey, uploadedBy, uploadedAt }` and `WorkerAllocatedToSiteEvent { tenantId, workerId, siteId, allocatedAt }` to `events.ts`. Shapes derived from `watcher.ts` field access patterns.

### CS-007 — RESOLVED 2026-04-24
- **Logged in:** Cross-slice session (2026-04-24)
- **Affects:** `packages/hr-service`
- **Files:** `packages/shared/src/types/agent.ts`, `packages/shared/src/types/workflow.ts`, `packages/hr-service/src/agents/vision-agent/state.ts`
- **Status:** RESOLVED 2026-04-24
- **Fix applied:** (1) Added `userId: string` to shared `VisionAgentState` in `agent.ts`. The note had the wrong target — the vision agent actually uses the local `state.ts`; `userId`, `workflowId`, `activityId`, `model`, `messages` were all added there. `runId`/`startedAt` made optional via `Omit<AgentState, 'runId' | 'startedAt'>` since the LangGraph initial state does not carry them. (2) Added `certificationId: string` and `objectStoreKey: string` to `CertProcessingInput` in `workflow.ts`.

### CS-001 — RESOLVED 2026-04-24
- **Logged in:** Slice 02 (Shared Types)
- **Affects:** scaffold utils (tenant-context.ts)
- **File:** `packages/shared/src/utils/tenant-context.ts`
- **Status:** RESOLVED 2026-04-24
- **Issue:** `systemRole` was removed from `TenantContext` but the middleware still extracted it from the JWT and used it to build the context object. `tenantConfig: TenantConfig` (now required) was missing entirely.
- **Fix applied:** Removed `systemRole` extraction; added a stub `tenantConfig` built from JWT `tenantId` + env vars (`KEYCLOAK_REALM`). Hydration from DB/cache is deferred to the tenant-config service slice.

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

### CS-008 — RESOLVED 2026-04-24
- **Logged in:** Cross-slice session (2026-04-24)
- **Affects:** `packages/hr-service`, `packages/shared`
- **Files:** `packages/shared/src/types/certification.ts`, `packages/shared/src/types/agent.ts`
- **Status:** RESOLVED 2026-04-24
- **Fix applied:** Option (b). Renamed `ExtractionResult` → `PersistedExtractionResult` in `certification.ts`. Added `export type ExtractionResult = z.infer<typeof ExtractionResultSchema>` in `agent.ts` (removed the re-export from certification.ts). Updated `CertProcessingOutput.extractionResult` in `workflow.ts` to use `PersistedExtractionResult`. Fixed `HitlResolution.corrections` (was `Partial<ExtractionResult['extracted']>`, now `Record<string, string>` — `.extracted` does not exist on the Zod-inferred shape).

### CS-009 — RESOLVED 2026-04-24
- **Logged in:** Cross-slice session (2026-04-24)
- **Affects:** `packages/teams-bot`
- **File:** `packages/teams-bot/src/bot.ts`
- **Status:** RESOLVED 2026-04-24
- **Fix applied:** (1) Removed `systemRole: 'worker'`; added stub `tenantConfig` built from env vars (`DEV_TENANT_ID`, `DEV_TENANT_NAME`, `LITELLM_VIRTUAL_KEY`, `KEYCLOAK_REALM`) — same pattern as CS-001 fix in `tenant-context.ts`. (2) Changed switch cases from `'cert_upload'`/`'compliance_query'` to `'UPLOAD_CERT'`/`'QUERY_COMPLIANCE'` to match `IntentResult.intent` UPPER_SNAKE_CASE union. Note: `IntentResultSchema` still uses snake_case — schema/type mismatch remains a runtime risk but is out of scope for this note.

### CS-010 — RESOLVED 2026-04-24
- **Logged in:** Slice 05 (HR Service Database Layer)
- **Affects:** Slice 02 (Shared Types) and all downstream consumers of `Worker`
- **File:** `packages/shared/src/types/worker.ts` (new file)
- **Status:** RESOLVED 2026-04-24
- **Fix applied:** Created `packages/shared/src/types/worker.ts` with the `Worker` interface. Added `export * from './types/worker.js'` to `packages/shared/src/index.ts`. Updated `packages/hr-service/src/db/queries/workers.ts` to import `Worker` via deep path `@cip/shared/src/types/worker.js` (bare package import not supported under Node16 module resolution without an `exports` field) and re-export it. Both `@cip/shared` and `@cip/hr-service` typecheck clean.

### CS-015 — RESOLVED 2026-04-25
- **Logged in:** Slice 07 (Vision Agent)
- **Affects:** Slice 02 (Shared Types)
- **File:** `packages/shared/src/types/agent.ts`
- **Status:** RESOLVED 2026-04-25
- **Fix applied:** (1) Added `tenantId: z.string().uuid()` to `ExtractionResultSchema` in `agent.ts`. (2) Updated `parseExtractionResponse` in `nodes.ts` to accept `tenantId` parameter and include it in the `.parse()` call; updated call site to pass `state.tenantId`. (3) Replaced the standalone `ExtractionResultSchema` definition in `zod-schemas.ts` with a re-export from `../types/agent.js` — single source of truth, no shape divergence. Full repo typecheck passes clean.

### CS-016 — RESOLVED 2026-04-25
- **Logged in:** Slice 08 (NATS Watcher)
- **Affects:** Slice 02 (Shared Types)
- **File:** `packages/shared/src/types/events.ts`
- **Status:** RESOLVED 2026-04-25
- **Fix applied:** Added `WorkerOnboardedEvent { tenantId: string; workerId: string; onboardedAt: string }` to `events.ts`. Both `@cip/shared` and `@cip/hr-service` typecheck clean.

### CS-017 — RESOLVED 2026-04-25
- **Logged in:** Slice 08 (NATS Watcher)
- **Affects:** Slice 02 (Shared Types)
- **File:** `packages/shared/src/utils/subject-builder.ts`
- **Status:** RESOLVED 2026-04-25
- **Fix applied:** Added `workerOnboarded: (tenantId: string) => buildSubject({ tenantId, domain: 'worker', event: 'onboarded' })` to the `Subjects` const. Both `@cip/shared` and `@cip/hr-service` typecheck clean.

### CS-018 — DEFERRED (architectural decision required)
- **Logged in:** Slice 21 (Teams Integration Audit)
- **Affects:** Slice 17 (Teams Bot Core)
- **File:** `packages/teams-bot/src/teams-protocol/channel-registry.ts`
- **Status:** DEFERRED
- **Issue:** The channel registry stores conversation references in a process-local in-memory Map with a 24-hour TTL; all registered channels are lost on pod restart.
- **Why it matters:** After a restart, `POST /proactive` will return 404 for every previously registered channel until each user sends a new message to re-register — proactive HITL notifications will be silently dropped in the interim.
- **Fix:** Architectural decision required — options are: Redis-backed registry (new infra dependency), NATS key-value store (already in-cluster), or PostgreSQL table in hr-service. Resolve before production launch.

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
