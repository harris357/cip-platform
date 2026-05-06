# Slice 63 — tenant tables move to `cip_platform`

> **Why this exists:** Phase 1 of Arc 1 auth/identity migration. Slice 62 created the empty `cip_platform` tables; slice 63 actually moves data and consumers. After this slice:
>
> - `cip_platform.tenants`, `tenant_identity_providers`, `tenant_settings`, `routing_rules` are the source of truth (populated)
> - The `cip_hr.*` equivalents are abandoned (data preserved, application no longer reads from them — drop migration is a follow-up)
> - All 4 admin tenant HTTP routes live on platform-core
> - teams-bot's tenant resolver calls platform-core (not hr-service)
> - hr-service's internal reads (tenant_settings, routing_rules) target `cip_platform.*` via cross-schema SELECT
> - `provision-tenant.sh` writes to `cip_platform.*`
> - `platform-core POST /tenants` no longer detours through hr-service (was its only HTTP dep on hr)
>
> **Hard cut.** No parallel running of code paths. Old `cip_hr.tenants*` tables linger as orphaned data only; their drop is a separate small follow-up slice (63b) once we're confident.
>
> See `ARC_1_AUTH_IDENTITY` for the full migration arc; see `SLICE_62_CIP_PLATFORM_SCAFFOLDING.md` for what already exists.

---

## Files in scope

```
# ── platform-core: data + routes + queries ──────────────────────────────
packages/platform-core/src/db/migrations/002_backfill_tenants.sql         NEW (~50 LOC — INSERT INTO cip_platform.* SELECT FROM cip_hr.*)
packages/platform-core/src/db/queries/tenants.ts                          NEW (~80 LOC — port of hr-service's tenants.ts; uses cip_platform pool)
packages/platform-core/src/db/queries/tenant-identity-providers.ts        NEW (~110 LOC — port)
packages/platform-core/src/db/queries/routing-rules.ts                    NEW (~70 LOC — port; reads cip_platform.routing_rules + tenant_settings)
packages/platform-core/src/routes/admin-tenants.ts                        NEW (~130 LOC — port of hr-service's admin-tenants.ts; same X-Platform-Admin-Token guard)
packages/platform-core/src/server.ts                                      MOD (mount adminTenantsRouter; remove the hr-service detour in POST /tenants)
packages/platform-core/src/index.ts                                       MOD (no change expected; verify)

# ── teams-bot: repoint resolver ─────────────────────────────────────────
packages/teams-bot/src/auth/tenant-resolver.ts                            MOD (call PLATFORM_CORE_URL instead of HR_SERVICE_URL; same path)
packages/teams-bot/helm/values.yaml                                       MOD (add PLATFORM_CORE_URL env)

# ── hr-service: delete admin routes; repoint internal reads ─────────────
packages/hr-service/src/routes/admin-tenants.ts                           DELETE
packages/hr-service/src/db/queries/tenants.ts                             DELETE (caller-less after this slice)
packages/hr-service/src/db/queries/tenant-identity-providers.ts           DELETE
packages/hr-service/src/db/queries/routing-rules.ts                       MOD (queries shift from `routing_rules` → `cip_platform.routing_rules`; from `tenant_settings` → `cip_platform.tenant_settings`)
packages/hr-service/src/server.ts (or wherever the router is mounted)     MOD (drop adminTenantsRouter import + mount)

# ── shared types: nothing changes ───────────────────────────────────────
# Tenant / TenantIdentityProvider / Provider zod types in @cip/shared stay as-is.

# ── ops: bash + helm ────────────────────────────────────────────────────
scripts/provision-tenant.sh                                               MOD (INSERT/UPDATE statements re-targeted to cip_platform.* via psql search_path or explicit prefixes)
packages/platform-core/helm/values.yaml                                   MOD (PLATFORM_ADMIN_TOKEN must already exist in envFrom — verify; add HR_SERVICE_URL no longer required for tenant ops, can stay for now)
```

Net code change: ~600 LOC moved (mostly identical port from hr-service to platform-core), ~50 LOC of cross-schema query updates in hr-service, ~10 LOC of teams-bot URL change.

---

## Hard rules

1. **Hard cut, no parallel paths.** After this slice deploys, the only code that reads or writes tenant data targets `cip_platform.*`. There is no fallback to `cip_hr.tenants` anywhere in application code. (Bash script and Helm config also flipped.)

2. **Cross-schema SELECTs are acceptable for hr-service reads.** Per D1 (same Postgres now, separate DB future), hr-service's internal reads of `cip_platform.tenant_settings` and `cip_platform.routing_rules` use `SELECT ... FROM cip_platform.<table>` directly via its existing `DATABASE_URL_HR` pool. This works because both schemas live in the same instance. **When/if DBs split** (a future slice), hr-service shifts these reads to an HTTP/MCP API call against platform-core. For now, the cross-schema query is the right cost/benefit.

3. **No cross-schema FKs.** Slice 62's hard rule still applies. `cip_platform.tenants` has no FK from hr-service tables; references are by `tenantId` UUID column with no DB-enforced relation.

4. **Backfill runs before drop.** The `002_backfill_tenants.sql` migration on platform-core copies data from `cip_hr.tenants*` into `cip_platform.tenants*`. The legacy `cip_hr.tenants*` tables are NOT dropped in this slice — that's slice 63b after a successful deploy. Reason: if the backfill or new code path has a bug, we can roll back and re-read from `cip_hr` without data loss.

5. **`platform-core POST /tenants` no longer calls hr-service.** Today it does this hop because hr-service owned the tenant table. After this slice, it writes directly to `cip_platform.tenants` then kicks the existing `TenantProvisioningWorkflow`. The HR_SERVICE_URL env var stays in platform-core for now (slice 67 may remove fully) but the call goes away.

6. **`PLATFORM_ADMIN_TOKEN` stays as the admin auth gate.** D8 deferred the real platform-admin auth to a later slice. The token-based auth ports verbatim from hr-service's admin-tenants.ts middleware to platform-core's. teams-bot's resolver continues to send `X-Platform-Admin-Token`.

7. **No new permissions, no new MCP tools.** This slice is HTTP routes + SQL only. The MCP server on platform-core is slice 66.

---

## SQL — `002_backfill_tenants.sql`

Cross-schema INSERT inside platform-core's migrate runner. Same Postgres, so cross-schema SELECTs work.

`ON CONFLICT ... DO UPDATE SET ...` (per Q4) so that if someone manually inserted into `cip_platform.*` between slices 62 and 63, the source-of-truth (`cip_hr.*`) wins on every column except `created_at` (which stays original).

```sql
-- Slice 63: backfill cip_platform.* from cip_hr.*. One-time copy; subsequent
-- writes go directly to cip_platform.*. The cip_hr equivalents are NOT
-- dropped here — slice 63b cleans them up after this slice deploys
-- successfully and we're confident no rollback is needed.

BEGIN;

-- 1. Tenants
INSERT INTO cip_platform.tenants
  (id, display_name, status, tier, admin_email, realm,
   created_at, updated_at, suspended_at, deleted_at)
SELECT
  id, display_name, status, tier, admin_email, realm,
  created_at, updated_at, suspended_at, deleted_at
FROM cip_hr.tenants
ON CONFLICT (id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  status       = EXCLUDED.status,
  tier         = EXCLUDED.tier,
  admin_email  = EXCLUDED.admin_email,
  realm        = EXCLUDED.realm,
  updated_at   = EXCLUDED.updated_at,
  suspended_at = EXCLUDED.suspended_at,
  deleted_at   = EXCLUDED.deleted_at;
  -- created_at intentionally NOT updated — preserve original timestamp.

-- 2. Identity providers
INSERT INTO cip_platform.tenant_identity_providers
  (id, tenant_id, provider_type, alias, enabled, config, secret_ref,
   created_at, updated_at)
SELECT
  id, tenant_id, provider_type, alias, enabled, config, secret_ref,
  created_at, updated_at
FROM cip_hr.tenant_identity_providers
ON CONFLICT (id) DO UPDATE SET
  tenant_id     = EXCLUDED.tenant_id,
  provider_type = EXCLUDED.provider_type,
  alias         = EXCLUDED.alias,
  enabled       = EXCLUDED.enabled,
  config        = EXCLUDED.config,
  secret_ref    = EXCLUDED.secret_ref,
  updated_at    = EXCLUDED.updated_at;

-- 3. Tenant settings
INSERT INTO cip_platform.tenant_settings
  (id, tenant_id, litellm_virtual_key, channel_config, routing_overrides, updated_at)
SELECT
  id, tenant_id, litellm_virtual_key, channel_config,
  COALESCE(routing_overrides, '{}'::jsonb),
  updated_at
FROM cip_hr.tenant_settings
ON CONFLICT (id) DO UPDATE SET
  tenant_id           = EXCLUDED.tenant_id,
  litellm_virtual_key = EXCLUDED.litellm_virtual_key,
  channel_config      = EXCLUDED.channel_config,
  routing_overrides   = EXCLUDED.routing_overrides,
  updated_at          = EXCLUDED.updated_at;

-- 4. Routing rules (global)
INSERT INTO cip_platform.routing_rules
  (service, purpose, alias, notes, updated_at, updated_by)
SELECT
  service, purpose, alias, notes, updated_at, updated_by
FROM cip_hr.routing_rules
ON CONFLICT (service, purpose) DO UPDATE SET
  alias      = EXCLUDED.alias,
  notes      = EXCLUDED.notes,
  updated_at = EXCLUDED.updated_at,
  updated_by = EXCLUDED.updated_by;

COMMIT;
```

**Note**: this migration assumes `cip_hr.tenants*` tables exist at the moment of run. Once slice 63b drops them, re-running 002 would fail (it references nonexistent tables). Two ways to handle:

- (a) Make the migration tolerant: wrap each `INSERT ... SELECT` in a check like `DO $$ BEGIN IF EXISTS (SELECT FROM information_schema.tables WHERE table_schema='cip_hr' AND table_name='tenants') THEN ... END IF; END $$;`
- (b) Accept that 002 only runs once (tracked by `cip_platform.schema_migrations`) and never re-runs after 63b lands. The `[skip] 002_backfill_tenants.sql` log is the indicator.

**Recommend (b).** Simpler, matches the existing migration tracking pattern. If a future fresh dev DB needs to re-bootstrap, the operator runs hr-service migrate first (creating cip_hr.* with sample data), then platform-core migrate (backfilling), then drops cip_hr.* manually.

---

## platform-core admin routes

`packages/platform-core/src/routes/admin-tenants.ts` — direct port of hr-service's file. Same Zod schemas, same X-Platform-Admin-Token guard, same 4 endpoints:

- `POST   /admin/tenants` — create tenant + IDPs (transactional)
- `GET    /admin/tenants` — list
- `GET    /admin/tenants/:id` — fetch one
- `GET    /admin/tenants/by-aad/:aadTenantId` — reverse lookup (hot path, called by bot every Teams message)

Difference from hr-service version:
- Imports from `../db/queries/tenants.js` and `../db/queries/tenant-identity-providers.js` (the new platform-core copies)
- Pool is `getPool()` from `../db/index.js` (slice 62's pool, against `cip_platform`)

Wire-up in `packages/platform-core/src/server.ts`:

```typescript
import { adminTenantsRouter } from './routes/admin-tenants.js';
app.use(adminTenantsRouter);
```

### `POST /tenants` cleanup (Q3 answer)

The existing `POST /tenants` endpoint has three problems we're fixing while we're in there:

1. Uses `tenantName` field name; `/admin/tenants` and the schema use `displayName`. Inconsistent.
2. Calls hr-service for the row insert (the architectural detour we're removing).
3. Has no clear separation of concerns — handler does both row creation AND workflow kickoff.

Cleanup:

- **Extract a shared service function** `createTenantWithProviders(input)` in `packages/platform-core/src/services/tenant-provisioning.ts` (NEW, ~80 LOC). Both `POST /admin/tenants` (admin row creation only) and `POST /tenants` (row creation + workflow kickoff) call this function. Eliminates duplication.
- **Rename input fields**: `POST /tenants` accepts `displayName` (was `tenantName`) and the rich `identityProviders[]` shape (synthesized from a top-level `aadTenantId` shorthand if present, for backwards-compat with the simplest caller). All other inputs (`adminEmail`, `tier`) keep their existing names.
- **Drop the hr-service call**: `POST /tenants` writes directly to `cip_platform.tenants` via the shared service.
- **Same response shape**: returns `{ tenantId, workflowId }` with 202 — preserves the public contract for any operator scripts that hit this endpoint.

This is a behavior change but a *backwards-compatible-on-output* change. Document the field rename (`tenantName → displayName`) in the slice's release notes; any caller still sending `tenantName` will get a Zod 400.

```typescript
// platform-core/src/services/tenant-provisioning.ts (NEW)
export async function createTenantWithProviders(input: CreateTenantInput): Promise<{
  tenant: Tenant;
  identityProviders: TenantIdentityProvider[];
}> {
  // Transactional INSERT into cip_platform.tenants + cip_platform.tenant_identity_providers
  // Returns the inserted rows. No workflow side effect — caller decides.
}

// platform-core/src/routes/admin-tenants.ts — POST /admin/tenants
//   calls createTenantWithProviders(...) and returns the result.

// platform-core/src/server.ts — POST /tenants
//   calls createTenantWithProviders(...), then kicks TenantProvisioningWorkflow,
//   returns { tenantId, workflowId }.
```

The added file:

```
packages/platform-core/src/services/tenant-provisioning.ts                NEW (~80 LOC)
```

---

## platform-core queries — direct port

`packages/platform-core/src/db/queries/tenants.ts`, `tenant-identity-providers.ts`, `routing-rules.ts` — verbatim ports from hr-service with two changes:

1. Pool source: `import { getPool } from '../db/index.js'` (the cip_platform pool from slice 62)
2. Table references: bare names work because the pool's connection string can include `?options=-c%20search_path=cip_platform,public` OR queries explicitly prefix `cip_platform.<table>`. Recommend explicit prefixes — clearer at the read site, no env-var-dependent behavior.

Drizzle alternative: use the typed table objects from `schema.ts` (`tenants`, `tenantIdentityProviders`, etc.) for the queries instead of raw SQL. This is the platform's modern pattern; hr-service's tenants.ts predates the drizzle adoption. Recommend drizzle queries here. ~30% less code, type-safe.

---

## hr-service changes

**Delete** `packages/hr-service/src/routes/admin-tenants.ts`. Remove its router mount in `server.ts` (or wherever).

**Delete** `packages/hr-service/src/db/queries/tenants.ts` and `tenant-identity-providers.ts`. After admin routes go away, no caller in hr-service references them. Verify with `grep -r "from.*db/queries/tenants\|from.*db/queries/tenant-identity-providers" packages/hr-service/src` — should return zero hits before deletion.

**Update** `packages/hr-service/src/db/queries/routing-rules.ts`:

```typescript
// BEFORE: SELECT ... FROM routing_rules ...
// AFTER:  SELECT ... FROM cip_platform.routing_rules ...

// BEFORE: SELECT routing_overrides FROM tenant_settings WHERE tenant_id = $1
// AFTER:  SELECT routing_overrides FROM cip_platform.tenant_settings WHERE tenant_id = $1
```

This works because hr-service's `DATABASE_URL_HR` connects to the same Postgres instance; cross-schema SELECT is a free operation. RLS on `cip_platform.tenant_settings` requires `app.current_tenant_id` to be set — which hr-service already does in its existing RLS-aware connection wrapper. Confirm at acceptance.

If there are other places in hr-service reading from `tenant_settings` or `tenants` directly (search: `grep -rn "FROM tenant_settings\|FROM tenants\b" packages/hr-service/src/`), repoint them all in this slice. Hard rule 1 says no parallel paths.

---

## teams-bot — `tenant-resolver.ts`

Single change: the URL it calls.

```typescript
// BEFORE
const url = `${process.env['HR_SERVICE_URL']}/admin/tenants/by-aad/${aadTenantId}`;

// AFTER
const url = `${process.env['PLATFORM_CORE_URL']}/admin/tenants/by-aad/${aadTenantId}`;
```

Path is identical (`/admin/tenants/by-aad/:aadTenantId`), so the response shape, error codes, and cache key all stay the same. The `X-Platform-Admin-Token` header is the same value.

`packages/teams-bot/helm/values.yaml`:

```yaml
env:
  # ... existing env ...
  PLATFORM_CORE_URL: http://platform-core.cip-app.svc.cluster.local:3001
  # HR_SERVICE_URL: kept for now — bot still calls hr-service for sync_employee
  # and get_employee_permissions until slice 66.
```

---

## `provision-tenant.sh`

The bash script writes to tenant tables in two places:

1. Initial tenant creation (psql INSERT into `tenants` — currently no schema prefix, hits `cip_hr.tenants` via search_path)
2. Per-tenant secret update (line 232: `UPDATE tenant_identity_providers SET secret_ref = ...`)

Both need to write to `cip_platform.*`. Two ways:

- (a) Set `search_path` at the top of each psql block: `\set search_path cip_platform,public`
- (b) Prefix every table reference: `INSERT INTO cip_platform.tenants ...`

**Recommend (b)** — explicit, no implicit search_path dependence. Slice 67 deletes this script entirely; this is band-aid until then.

---

## Acceptance criteria

1. **`pnpm -r run typecheck` clean** after all changes.

2. **Backfill runs cleanly** on a dev DB with at least 1 tenant in `cip_hr`:
   - `pnpm --filter @cip/platform-core migrate` applies `002_backfill_tenants.sql`
   - `SELECT count(*) FROM cip_platform.tenants` matches `SELECT count(*) FROM cip_hr.tenants`
   - Same for `tenant_identity_providers`, `tenant_settings`, `routing_rules`
   - Re-running migrate is a no-op (`[skip] 002_backfill_tenants.sql`)

3. **platform-core admin routes work**:
   - `curl -H "X-Platform-Admin-Token: $TOKEN" http://platform-core/admin/tenants` returns the list
   - `curl -H "..." http://platform-core/admin/tenants/by-aad/<aad-id>` returns the tenant + provider
   - `POST /admin/tenants` creates a new tenant (transaction is atomic — fail one IDP, all rolled back)

4. **teams-bot resolver uses platform-core**:
   - Tail bot logs during a Teams message; the resolver call goes to `platform-core.cip-app...` (not hr-service)
   - `cache hit` and `cache miss` paths both work; same TTL semantics

5. **hr-service still resolves routing**:
   - Existing routing-rules query against `cip_platform.routing_rules` returns the same data as before the migration
   - LLM calls succeed (which require routing rules to resolve aliases)

6. **`platform-core POST /tenants`** creates a tenant without calling hr-service:
   - tcpdump or service mesh trace shows zero outbound calls to hr-service from platform-core's POST /tenants handler
   - Workflow still kicks off (TenantProvisioningWorkflow workflow ID with the new tenantId)

7. **hr-service has no admin-tenants routes**:
   - `curl http://hr-service/admin/tenants` returns 404
   - `grep -r adminTenantsRouter packages/hr-service/src` returns zero hits

8. **No regressions in hr-service tests**: `pnpm --filter @cip/hr-service test`

---

## Test plan

- **Unit (platform-core)**: zod parse for create-tenant payload; error paths (validation, missing token, conflict on duplicate AAD tenant ID via IDP).
- **Integration (local DB)**:
  1. Seed `cip_hr.tenants` with 2 fake tenants + IDPs + settings + 5 routing_rules
  2. Run platform-core migrate; verify `cip_platform.*` matches
  3. Curl all 4 platform-core admin routes against the migrated data; assert response shapes match the previous hr-service responses
  4. Run `provision-tenant.sh` against the dev cluster (or dry-run) and confirm it writes to `cip_platform.*`
- **End-to-end**: from a Teams message, confirm the bot resolves tenant via platform-core (Langfuse trace shows the new URL).

---

## Forward refs (separate slices, not part of 63)

- **Slice 63b — drop legacy cip_hr tenant tables.** `046_drop_legacy_tenants.sql` in hr-service: `DROP TABLE cip_hr.tenants, tenant_identity_providers, tenant_settings, routing_rules`. Trigger: a week of running on `cip_platform.*` with no rollback. ~30 LOC; verifies via `\d cip_hr.tenants` returning empty.
- **Slice 66 — platform-core MCP server.** Adds `tenant.lookup_by_aad` MCP tool so the bot can use MCP instead of HTTP if desired. Today's HTTP path stays.
- **Slice 67 — kill `provision-tenant.sh`.** Activities own the writes; bash gone.

---

## Risks

- **Risk**: cross-schema SELECT in hr-service requires the `cip_platform` schema to be on its `search_path` OR explicit `cip_platform.<table>` prefix. If neither is set, queries silently fail with "relation does not exist."
  - **Mitigation**: enforce explicit `cip_platform.<table>` prefix in every query. No `search_path` dependence.

- **Risk**: RLS on `cip_platform.tenant_settings` blocks hr-service reads when `app.current_tenant_id` isn't set on its connection.
  - **Mitigation**: hr-service already wraps connections with the GUC for its own RLS tables; same wrapper covers cross-schema reads. Verify in test plan step 4.

- **Risk**: backfill `ON CONFLICT (id) DO NOTHING` silently drops a row whose data has diverged between cip_hr and cip_platform. Possible if someone manually inserted into cip_platform between slice 62 and slice 63 deploy.
  - **Mitigation**: in practice nobody writes to cip_platform between 62 and 63. Acceptance criterion 2 (row counts match) is the check.

- **Risk**: teams-bot's resolver fails closed if `PLATFORM_CORE_URL` env var is missing post-deploy.
  - **Mitigation**: helm values.yaml sets a default. Bot's `tenant-resolver.ts` should already throw a structured error on missing env (it does today for `HR_SERVICE_URL`).

- **Risk**: `provision-tenant.sh` written for old schema runs against new tables and partially succeeds, leaving a half-provisioned state.
  - **Mitigation**: bash changes go in this slice. Don't re-run old bash against new schema. Slice 67 retires the bash entirely.

---

## Cross-slice notes

- Slice 64 (User/Employee split) lands the first writes to `cip_platform.users` and adds the `user_id` FK column on `cip_hr.employees`. That FK is intentionally a UUID column, NOT a Postgres FK constraint, per slice 62's hard rule 2.
- Slice 65 (auth API + `@cip/auth`) when permission resolution moves and `permission_catalog` starts being populated.
- Slice 63b is a small follow-up that drops the legacy `cip_hr.tenants*` tables once we're confident in the cut. Could ship within a week of slice 63 if no rollback is needed.

---

## Locked decisions

1. **Drizzle in platform-core's queries** — typed table objects from `schema.ts`; no raw SQL in the new query files.
2. **`provision-tenant.sh`** — explicit `cip_platform.<table>` prefix on every reference.
3. **`POST /tenants` cleaned up** — shared `createTenantWithProviders` service function; `displayName` field (was `tenantName`); no hr-service detour. Output contract `{ tenantId, workflowId }` preserved.
4. **Backfill `ON CONFLICT DO UPDATE SET`** — column-by-column, source (`cip_hr`) wins on conflict, `created_at` preserved.
5. **hr-service cross-schema reads** — explicit `cip_platform.<table>` prefix in every query; no search_path manipulation.

Slice is locked.

---

## Implementation status

**Implemented in commit-pending state on 2026-05-06.** Files touched:

**platform-core (new):**
- `packages/platform-core/src/db/migrations/002_backfill_tenants.sql` — 4-table backfill with `ON CONFLICT DO UPDATE SET`
- `packages/platform-core/src/db/queries/tenants.ts` — drizzle queries
- `packages/platform-core/src/db/queries/tenant-identity-providers.ts` — drizzle queries (incl. `findActiveAadTenant` JOIN)
- `packages/platform-core/src/db/queries/routing-rules.ts` — drizzle queries (rules + tenant routing overrides)
- `packages/platform-core/src/services/tenant-provisioning.ts` — shared `createTenantWithProviders` (transactional)
- `packages/platform-core/src/routes/admin-tenants.ts` — port of 4 admin endpoints with X-Platform-Admin-Token guard

**platform-core (modified):**
- `packages/platform-core/src/server.ts` — mount `adminTenantsRouter` before `tenantAuthMiddleware`
- `packages/platform-core/src/routes/tenant.ts` — rewrite `POST /tenants`: drops hr-service detour, uses shared service, renames `tenantName` → `displayName`, supports both `aadTenantId` shorthand and rich `identityProviders[]`
- `packages/platform-core/src/db/index.ts` — narrow `Db` type to `NodePgDatabase<typeof schema>` so transaction handles satisfy query function signatures

**teams-bot:**
- `packages/teams-bot/src/auth/tenant-resolver.ts` — URL flipped from `HR_SERVICE_URL` to `PLATFORM_CORE_URL` (same path, same headers)
- `packages/teams-bot/helm/values.yaml` — added `PLATFORM_CORE_URL` env var

**hr-service:**
- `packages/hr-service/src/server.ts` — dropped `adminTenantsRouter` import + mount
- `packages/hr-service/src/db/schema.ts` — `tenantSettings` redefined under `pgSchema('cip_platform')`; added `routingOverrides` column to align with platform-core's schema. Drizzle now emits `cip_platform.tenant_settings` automatically. Existing consumer `get-tenant-channel-config.ts` works unchanged.
- `packages/hr-service/src/db/queries/routing-rules.ts` — explicit `cip_platform.routing_rules` and `cip_platform.tenant_settings` prefixes in all 3 raw-SQL queries
- DELETED: `packages/hr-service/src/routes/admin-tenants.ts`
- DELETED: `packages/hr-service/src/db/queries/tenants.ts`
- DELETED: `packages/hr-service/src/db/queries/tenant-identity-providers.ts`

**bash:**
- `scripts/bootstrap.sh` — `INSERT INTO cip_platform.tenants` and `cip_platform.tenant_identity_providers`
- `scripts/provision-tenant.sh` — `UPDATE cip_platform.tenant_identity_providers` + doc text references updated

**Type fixes encountered during implementation:**
- `Db` narrowed to `NodePgDatabase<typeof schema>` (was `ReturnType<typeof drizzle<...>>` which included `& {$client: Pool}` and broke transaction handles)
- Optional fields from zod (`secretRef?: string | undefined`, `enabled?: boolean | undefined`) explicitly mapped to drop `undefined` to satisfy `exactOptionalPropertyTypes` when calling the service
- `TenantProvisioningInput.tier` enum mismatch with `TenantTierSchema` (legacy `premium` vs current `trial`); cast at the boundary with a comment flagging the divergence as a separate cleanup

**Verification:**
- ✅ `pnpm --filter @cip/platform-core typecheck` clean
- ✅ `pnpm --filter @cip/hr-service typecheck` clean
- ✅ `pnpm --filter @cip/teams-bot typecheck` clean
- ✅ `pnpm -r run typecheck` clean (no regressions)
- ✅ `pnpm --filter @cip/platform-core build` produces `dist/routes/admin-tenants.js`, `dist/services/tenant-provisioning.js`, `dist/db/migrate.js`
- ⏳ DB-level verification (criteria 2-7) requires a dev DB with seeded `cip_hr.tenants*` data. Operator runs `pnpm --filter @cip/platform-core migrate` to apply backfill, then exercises the new admin routes via curl.
