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

### CS-022
- **Logged in:** Slice 39A (Per-Purpose LLM Routing Foundation)
- **Affects:** Slice 05A (HR domain schema) + future platform-config refactor
- **Files:**
  - `packages/hr-service/src/db/migrations/009_routing_rules.sql`
  - `packages/hr-service/src/db/migrations/004_tenants.sql`
  - `packages/hr-service/src/db/migrations/005_tenant_settings.sql` (or wherever tenant_settings lives)
- **Status:** OPEN
- **Issue:** `routing_rules` joins `tenants`, `tenant_settings`, and
  `tenant_identity_providers` as platform-level config that physically
  lives in `cip_hr` (hr-service's DB). Architecturally these all belong
  in `cip_platform` (platform-core's DB). The routing table perpetuates
  the existing smell rather than fixing it.
- **Why it matters:** Cross-service queries like "what did Acme spend
  on bot routing this month?" naturally join `routing_rules` with tenant
  metadata, which is co-located today — fine for now. But if a future
  tenant-onboarding workflow in platform-core wants to seed
  `routing_rules` at provision time (similar to the role catalog seed
  CS-021 fixed), it needs to either reach across to cip_hr or call
  hr-service via HTTP. Adds friction; conflicts with the goal of
  making platform-core the canonical owner of platform-scoped data.
- **Fix:** A future cleanup slice migrates `tenants`,
  `tenant_identity_providers`, `tenant_settings`, `routing_rules` →
  `cip_platform`. hr-service queries these via an internal `/admin`
  endpoint on platform-core. Estimated effort: 1–2 days, mostly
  mechanical (`pg_dump | restore` for the four tables, repoint
  callers in hr-service to platform-core HTTP).
- **Defer until:** platform-core has a second consumer for this data,
  OR a customer onboarding flow needs DB-level access to
  `routing_rules` at provision time.

### CS-021
- **Logged in:** Slice 38 (Module-Level Permissions)
- **Affects:** Slice 05A (HR domain schema), `@cip/platform-core` tenant
  provisioning activity
- **Files:**
  - `packages/hr-service/src/db/migrations/002_domain_model.sql`
  - `packages/platform-core/src/activities/init-tenant-database.activity.ts`
- **Status:** RESOLVED — 2026-04-30 (Slice 38)
- **Issue:** Slice 38's spec assumed the `roles` table had a `code TEXT`
  column with `(tenant_id, code)` UNIQUE; the actual schema from Slice 05A
  had only `keycloak_role` with `(tenant_id, keycloak_role)` UNIQUE, and
  used a `capabilities JSONB` object instead of the new `permissions JSONB`
  array. Additionally, `init-tenant-database.activity.ts` in platform-core
  seeded the legacy `capabilities` shape during tenant bootstrap, and its
  `keycloak_role` values (`hr_admin`, `field_operations`, etc.) didn't
  correspond to any realm role after Slice 32 (which defines only `hr` and
  `employee`).
- **Why it matters:** Without these fixes, new tenants provisioned via
  platform-core would (a) violate the new `(tenant_id, code) NOT NULL`
  UNIQUE constraint at INSERT time, and (b) receive realm-role values
  that no JWT would carry — every HR-only tool gate would refuse.
- **Resolution (hr-service):** `008_role_permissions.sql` (Slice 38) adds
  `code TEXT NOT NULL` (backfilled from `keycloak_role`), drops the legacy
  `(tenant_id, keycloak_role)` UNIQUE, adds `(tenant_id, code)` UNIQUE,
  and adds `permissions JSONB NOT NULL DEFAULT '[]'`. The `capabilities`
  column remains in place (default `{}`) to avoid an INSERT-incompatible
  migration; future cleanup slice can drop it once no consumer remains.
- **Resolution (platform-core):** `init-tenant-database.activity.ts`
  rewrites the SYSTEM_ROLES catalog to emit `code` + `keycloak_role` +
  `permissions` for each of the five seeded roles. `keycloak_role` is
  now strictly `'hr'` or `'employee'` aligned with Slice 32's realm
  catalog. Permissions use the Slice 38 dot-style codes
  (`employee.*`, `cert.*`, `compliance.*`). The INSERT uses ON CONFLICT
  `(tenant_id, code) DO UPDATE` so re-runs converge the catalog
  forward as the platform role definitions evolve. The `capabilities`
  column is no longer set; the table default (`'{}'::jsonb`) applies.

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


