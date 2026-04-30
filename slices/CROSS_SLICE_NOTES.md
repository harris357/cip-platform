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

### CS-021
- **Logged in:** Slice 38 (Module-Level Permissions)
- **Affects:** Slice 05A (HR domain schema), `@cip/platform-core` tenant
  provisioning activity
- **Files:**
  - `packages/hr-service/src/db/migrations/002_domain_model.sql`
  - `packages/platform-core/src/activities/init-tenant-database.activity.ts`
- **Status:** RESOLVED inline (hr-service) / OPEN (platform-core) — 2026-04-30 (Slice 38)
- **Issue:** Slice 38's spec assumed the `roles` table had a `code TEXT`
  column with `(tenant_id, code)` UNIQUE; the actual schema from Slice 05A
  had only `keycloak_role` with `(tenant_id, keycloak_role)` UNIQUE, and
  used a `capabilities JSONB` object instead of the new `permissions JSONB`
  array. Additionally, `init-tenant-database.activity.ts` in platform-core
  seeds the legacy `capabilities` shape during tenant bootstrap.
- **Why it matters:** New tenants provisioned via platform-core will not
  automatically receive `permissions` arrays. The existing `capabilities`
  column is dead code post-Slice-38 (the only consumer, the
  `get_employee_capabilities` tool, has been removed).
- **Resolution (hr-service):** `008_role_permissions.sql` (Slice 38) adds
  `code TEXT NOT NULL` (backfilled from `keycloak_role`), drops the legacy
  `(tenant_id, keycloak_role)` UNIQUE, adds `(tenant_id, code)` UNIQUE,
  and adds `permissions JSONB NOT NULL DEFAULT '[]'`. The `capabilities`
  column remains in place to avoid an INSERT-incompatible migration.
- **Outstanding (platform-core):** Update
  `init-tenant-database.activity.ts` to emit `code` and `permissions`
  for each seeded role (mapping the existing four-role catalog to the
  Slice 38 permission codes: `employee.list`, `cert.submit`,
  `cert.view_own`, `cert.list_all`, `cert.approve`, `compliance.view`,
  etc). Remove the `capabilities` field once all dev/prod tenants have
  been re-seeded.

### CS-019
- **Logged in:** Slice 33 (HR MCP Tools + Migration + Disable)
- **Affects:** Slice 05A (HR domain schema)
- **File:** `packages/hr-service/src/db/migrations/002_domain_model.sql`
- **Status:** RESOLVED inline — 2026-04-30 (Slice 33)
- **Issue:** The `employees` table from Slice 05A had no column representing
  active/disabled state, but Slice 33's disable workflow needs one.
- **Resolution:** Added `disabled_at TIMESTAMPTZ` via new migration
  `007_employee_disabled_at.sql` and a corresponding partial index
  `idx_employees_tenant_active`. Drizzle schema entry updated. NULL =
  active; non-NULL = disabled at that timestamp. If a future cleanup
  slice consolidates migrations into `002_domain_model.sql`, fold this
  ALTER into the original CREATE TABLE.

### CS-020
- **Logged in:** Slice 33 (HR MCP Tools + Migration + Disable)
- **Affects:** `@cip/shared` `subject-builder.ts` and `events.ts`
- **File:** `packages/shared/src/utils/subject-builder.ts`, `packages/shared/src/types/events.ts`
- **Status:** RESOLVED inline — 2026-04-30 (Slice 33)
- **Issue:** Slice 33 publishes `Subjects.employeeIdentityChanged` and
  `Subjects.employeeDisabled` from its workflows but neither subject nor
  event type existed in `@cip/shared`.
- **Resolution:** Added both factory entries to `Subjects` and the
  corresponding `EmployeeIdentityChangedEvent` / `EmployeeDisabledEvent`
  interfaces. Bootstrap NATS streams already cover the
  `cip.*.employee.>` filter (HR_EVENTS stream from `bootstrap.sh`), so
  no stream changes needed.

### CS-018
- **Logged in:** Slice 21 (Teams Integration Audit)
- **Affects:** Slice 17 (Teams Bot Core)
- **File:** `packages/teams-bot/src/teams-protocol/channel-registry.ts`
- **Status:** RESOLVED — 2026-04-27 (Slice 26)
- **Issue:** The channel registry stored conversation references in a process-local in-memory Map with a 24-hour TTL; all registered channels were lost on pod restart.
- **Resolution:** Replaced in-memory Map with NATS JetStream KV bucket `teams-channel-registry` (TTL 24h, history 1). Bucket created idempotently by `scripts/bootstrap.sh`. `CHANNEL_REGISTRY_BUCKET` env var exposed in helm values. `registerChannel` and `getChannelRef` are now async; `server.ts` updated to `await getChannelRef`.

---

## Resolved Notes

_(prior resolved notes archived to slices/archive/CROSS_SLICE_NOTES.md)_

### Known Deferred (pre-existing, requires architectural decision)


