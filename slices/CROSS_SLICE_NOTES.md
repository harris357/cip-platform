# CIP Platform — Cross-Slice Notes

> Log issues discovered during a slice session that require a fix in an earlier slice.
> Resolve using `PROMPT CROSS-SLICE` from `PROMPTS_ALL.md` before starting the next slice.

---

## Template

```
### CS-NNN
- **Logged in:** Slice NN (name)
- **Affects:** Slice NN (name)
- **File:** packages/.../src/...
- **Status:** OPEN
- **Issue:** One sentence.
- **Why it matters:** Which downstream slices or runtime behaviours break.
- **Fix:** Exact change required.
```

---

## Open Notes

_(no open notes)_

---

## Resolved Notes

### CS-007
- **Logged in:** Slice 14 (Matching Activities)
- **Affects:** Slice 06 stub — `persist-cert.activity.ts`
- **File:** `packages/hr-service/src/modules/certifications/activities/persist-cert.activity.ts`
- **Status:** RESOLVED 2026-04-27
- **Issue:** `PersistCertInput.matchedEmployeeId` and `certDefId` were typed as non-optional `string` in the Slice 06 stub, but the Slice 14 match result types correctly expose `employeeId?: string` and `certDefId?: string` (a `no_match` result produces no ID). Passing `string | undefined` to `string` caused a typecheck failure in the workflow under `exactOptionalPropertyTypes: true`.
- **Why it matters:** Typecheck blocked; and the non-optional types would have forced the persist activity implementer to assume a match always exists, which is wrong — HITL resolution may still leave a null match.
- **Fix applied:** Changed `matchedEmployeeId` and `certDefId` to `string | undefined` in `PersistCertInput`. The `persistCertActivity` implementer must guard against undefined values (e.g., require HITL resolution before persisting, or throw if either ID is absent).

### CS-006
- **Logged in:** Slice 08 (NATS Watcher)
- **Affects:** Slice 02 (Shared Types)
- **Status:** RESOLVED 2026-04-27
- **Fix applied:**
  1. Added `'employee'` to `NatsDomain` union in `subject-builder.ts`
  2. Added `employeeOnboarded: (tenantId: string) => buildSubject(...)` to `Subjects`
  3. Replaced raw `EMPLOYEE_ONBOARDED_SUBJECT` string in `watcher.ts` with `Subjects.employeeOnboarded('*')`

### CS-005
- **Logged in:** Slice 08 (NATS Watcher)
- **Affects:** Slice 02 (Shared Types)
- **Status:** RESOLVED 2026-04-27
- **Fix applied:**
  1. Added `EmployeeOnboardedEvent` interface to `packages/shared/src/types/events.ts`
  2. Replaced local interface in `watcher.ts` with `import type { ..., EmployeeOnboardedEvent }` from shared
  3. Removed stale cross-slice comment block from bottom of `watcher.ts`

### CS-004
- **Logged in:** Slice 06 (HR Temporal Workflows)
- **Affects:** Slice 14 (Matching Activities)
- **Status:** RESOLVED 2026-04-27
- **Fix applied:**
  1. Created `packages/hr-service/src/modules/certifications/activities/publish-cert-processed.activity.ts` — stub throwing `'not implemented'`
  2. Exported `publishCertProcessedActivity` and `PublishCertProcessedInput` from `activities/index.ts`
  3. Added `publishCertProcessedActivity` to `proxyActivities` destructure in workflow
  4. Replaced `// TODO` + `void certificationId` with `await publishCertProcessedActivity(...)` call

### CS-003
- **Logged in:** Slice 05A (HR Domain Schema)
- **Affects:** AI calibration/memory slice
- **Status:** RESOLVED 2026-04-27
- **Fix applied:**
  1. Created `packages/hr-service/src/db/migrations/003_ai_memory.sql`
  2. Ports `field_outcomes`, `memory_writes`, and `agent_memory_vectors` tables from `001_initial.sql`
  3. Updated to 002 RLS pattern: `CREATE TABLE IF NOT EXISTS`, `gen_random_uuid()`, `CREATE POLICY tenant_isolation ON <table>`
  4. Includes `CREATE EXTENSION IF NOT EXISTS "vector"` for pgvector support

### CS-001
- **Logged in:** Consistency review (env var audit)
- **Affects:** Slice 05A (HR Domain Schema), Slice 02 (Shared Types), Slice 07, Slice 14
- **Status:** RESOLVED 2026-04-26
- **Fix applied:**
  1. Created `packages/hr-service/src/db/migrations/002_domain_model.sql` — `tenant_settings` table with `litellm_virtual_key TEXT NOT NULL` and RLS policy
  2. Updated `initTenantDatabase` to accept `litellmVirtualKey` and upsert into `tenant_settings`
  3. Reordered `TenantProvisioningWorkflow`: step 5 now issues the key, step 6 inits DB + stores the key
  4. `nodes.ts` (Slice 07): replaced `process.env['LITELLM_VIRTUAL_KEY']` with `withTenantRLS` DB lookup
  5. `bot.ts` (Slice 14): replaced `process.env['LITELLM_VIRTUAL_KEY']` with `withTenantRLS` DB lookup
  6. Confirmed `litellmVirtualKey` source comment in `TenantConfig`
  7. Fixed pre-existing shared type gaps found during typecheck: `TenantProvisioningInput`, `CertProcessingInput`, `CertUploadedEvent`, `CertProcessedEvent`, `CertExpiredEvent`, `Certification`, `Worker`, aligned `ExtractionResult` schema with consuming code

### CS-002
- **Logged in:** Slice 05A (HR Domain Schema)
- **Affects:** Slice 05A (HR Domain Schema)
- **File:** `packages/hr-service/src/db/migrations/002_domain_model.sql`
- **Status:** RESOLVED 2026-04-26
- **Fix applied:** Added `litellm_virtual_key TEXT NOT NULL DEFAULT ''` back to `tenant_settings` in `002_domain_model.sql` alongside `channel_config`.

_(prior resolved notes archived to slices/archive/CROSS_SLICE_NOTES.md)_
