# Slice 62 — `cip_platform` schema scaffolding

> **Why this exists:** Phase 0 of the Arc 1 auth/identity migration.
> platform-core today is HTTP + Temporal worker only — no DB, no auth
> API, no MCP server. Before we can move tenant tables (slice 63) or
> split User out of Employee (slice 64), platform-core needs a database
> of its own to write into. This slice creates that foundation: a
> `cip_platform` schema in the existing Postgres instance, with empty
> table definitions matching the future shape, plus the migration
> runner + drizzle wiring + connection pool inside platform-core.
>
> **Pure scaffolding.** No data is moved, no service reads or writes
> from these tables yet, no behavior changes. Every existing query
> against `cip_hr.tenants`, `cip_hr.employees`, etc. continues to work
> exactly as it does today. This slice is verifiable by running the
> migrations and confirming the empty tables exist.
>
> See `ARC_1_AUTH_IDENTITY` (chain doc) for the full migration arc.

---

## Files in scope

```
packages/platform-core/package.json                                       MOD (add pg, drizzle-orm, @types/pg at LATEST STABLE versions; add migrate script)
packages/platform-core/src/db/                                            NEW directory
├── index.ts                                                              NEW (~40 LOC — pg pool + drizzle client; mirrors hr-service pattern)
├── migrate.ts                                                            NEW (~60 LOC — copy of hr-service migrate.ts, env var DATABASE_URL_PLATFORM)
├── schema.ts                                                             NEW (~150 LOC — drizzle table defs for all 10 tables)
└── migrations/
    └── 001_init.sql                                                      NEW (~200 LOC — schema + 10 empty tables + RLS for tenant-scoped ones)

packages/platform-core/helm/templates/deployment.yaml                     MOD (add migrate initContainer — matches hr-service pattern)
packages/platform-core/Dockerfile                                         MOD (COPY .sql migrations into dist/db/migrations — tsc doesn't bundle non-TS assets)

# Operator step (out-of-band, not a code change):
#   Add DATABASE_URL_PLATFORM key to the existing `platform-core-credentials`
#   K8s secret. The deployment's `envFrom` already pulls that secret.
```

~450 LOC total, mostly SQL + drizzle wrappers. No new pods, no new images, no application logic touched.

---

## Hard rules

1. **Empty tables only.** No `INSERT`, no seed data, no backfill from `cip_hr`. Slice 63+ moves data; slice 62 just lays the slab.

2. **No cross-schema foreign keys.** Per the architectural decision in the migration plan: design assumes `cip_platform` may move to a separate physical database later. Use UUID references across schema boundaries; resolve via API at the application layer. Within `cip_platform`, normal FKs are fine (e.g., `tenant_settings.tenant_id → tenants.id`).

3. **Mirror final shape, not historical accidents.** Where `cip_hr` has migrations that renamed columns mid-stream (e.g., slice 42A renamed `roles → permission_groups`, slice 42C added the new `roles` layer), `cip_platform` lands the *current* shape directly. No carrying forward stale columns or renames.

4. **RLS at table-creation time** for tenant-scoped tables (`users`, `tenant_settings`, `user_role_assignments`). Don't defer RLS to a later slice. Empty tables with RLS are safe; tables that ever held data without RLS are a security audit problem later.

5. **Same Postgres instance, separate schema.** Per D1=B. New env var `DATABASE_URL_PLATFORM` so we can split databases later via config without code change. Today, `DATABASE_URL_PLATFORM` and `DATABASE_URL_HR` typically point to the same instance with different `search_path`.

6. **Idempotent migration.** All `CREATE` statements use `IF NOT EXISTS`. The schema_migrations tracking table prevents re-application; idempotent DDL is belt-and-braces.

7. **No drizzle migrations workflow** — match hr-service's pattern: drizzle for schema typing + queries, raw SQL files for migrations executed by `pnpm migrate`.

8. **Latest stable libraries.** `pnpm add` resolves `drizzle-orm`, `pg`, `@types/pg` at the highest stable versions available at implementation time. Do NOT pin to hr-service's currently-installed versions if newer stable releases exist. If the latest stable diverges from hr-service's installed version, flag a cross-slice note to upgrade hr-service in lockstep — but don't do that upgrade in this slice.

---

## SQL migration — `001_init.sql`

```sql
-- Slice 62 — cip_platform schema foundation.
-- Empty tables for the auth/identity migration. No data movement here.
-- Slice 63+ backfills from cip_hr.

CREATE SCHEMA IF NOT EXISTS cip_platform;

SET search_path TO cip_platform;

-- ============================================================
-- TENANTS (platform-level, NO RLS)
-- ============================================================

CREATE TABLE IF NOT EXISTS cip_platform.tenants (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name  TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','suspended','deleted')),
  tier          TEXT NOT NULL DEFAULT 'standard'
                  CHECK (tier IN ('standard','enterprise','trial')),
  admin_email   TEXT NOT NULL,
  realm         TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  suspended_at  TIMESTAMPTZ,
  deleted_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_tenants_status ON cip_platform.tenants(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_realm ON cip_platform.tenants(realm);

CREATE TABLE IF NOT EXISTS cip_platform.tenant_identity_providers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES cip_platform.tenants(id) ON DELETE CASCADE,
  provider_type   TEXT NOT NULL
                    CHECK (provider_type IN (
                      'aad_oidc','google_oidc','generic_oidc',
                      'saml','sms_otp','local_password'
                    )),
  alias           TEXT NOT NULL,
  enabled         BOOLEAN NOT NULL DEFAULT true,
  config          JSONB NOT NULL DEFAULT '{}'::jsonb,
  secret_ref      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, alias)
);
CREATE INDEX IF NOT EXISTS idx_tip_tenant_enabled
  ON cip_platform.tenant_identity_providers(tenant_id) WHERE enabled = true;
CREATE INDEX IF NOT EXISTS idx_tip_aad_lookup
  ON cip_platform.tenant_identity_providers((config ->> 'aad_tenant_id'))
  WHERE provider_type = 'aad_oidc' AND enabled = true;

CREATE TABLE IF NOT EXISTS cip_platform.tenant_settings (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL UNIQUE REFERENCES cip_platform.tenants(id) ON DELETE CASCADE,
  litellm_virtual_key TEXT NOT NULL DEFAULT '',
  channel_config      JSONB NOT NULL DEFAULT '{}'::jsonb,
  routing_overrides   JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE cip_platform.tenant_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON cip_platform.tenant_settings
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID);

-- ============================================================
-- ROUTING (global, no RLS)
-- ============================================================

CREATE TABLE IF NOT EXISTS cip_platform.routing_rules (
  service     TEXT        NOT NULL,
  purpose     TEXT        NOT NULL,
  alias       TEXT        NOT NULL,
  notes       TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by  TEXT,
  PRIMARY KEY (service, purpose)
);

-- ============================================================
-- USERS (tenant-scoped, RLS)
-- ============================================================

CREATE TABLE IF NOT EXISTS cip_platform.users (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL,
  email          TEXT NOT NULL,
  full_name      TEXT NOT NULL,
  given_name     TEXT,
  surname        TEXT,
  keycloak_id    TEXT,
  aad_oid        TEXT,
  identity_type  TEXT NOT NULL
                   CHECK (identity_type IN ('aad_federated','field_employee','local_password')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, email)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_tenant_keycloak_id
  ON cip_platform.users(tenant_id, keycloak_id) WHERE keycloak_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_tenant_aad_oid
  ON cip_platform.users(tenant_id, aad_oid) WHERE aad_oid IS NOT NULL;

ALTER TABLE cip_platform.users ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON cip_platform.users
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID);

-- ============================================================
-- ROLES + PERMISSION GROUPS + ASSIGNMENTS
-- ============================================================
-- Modeled on cip_hr's final shape post-slice-42C:
--   - permission_groups hold the actual permission codes (JSONB array)
--   - roles compose permission_groups via role_groups
--   - user_role_assignments grants roles to users

CREATE TABLE IF NOT EXISTS cip_platform.permission_groups (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL,
  code           TEXT NOT NULL,
  label          TEXT NOT NULL,
  description    TEXT,
  service        TEXT NOT NULL,
  module         TEXT NOT NULL,
  permissions    JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_system      BOOLEAN NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, service, module, code)
);

CREATE TABLE IF NOT EXISTS cip_platform.roles (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL,
  code           TEXT NOT NULL,
  label          TEXT NOT NULL,
  description    TEXT,
  keycloak_role  TEXT NOT NULL,
  is_system_role BOOLEAN NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, code)
);

CREATE TABLE IF NOT EXISTS cip_platform.role_groups (
  role_id  UUID NOT NULL REFERENCES cip_platform.roles(id)              ON DELETE CASCADE,
  group_id UUID NOT NULL REFERENCES cip_platform.permission_groups(id)  ON DELETE CASCADE,
  PRIMARY KEY (role_id, group_id)
);

CREATE TABLE IF NOT EXISTS cip_platform.user_role_assignments (
  user_id     UUID NOT NULL,
  role_id     UUID NOT NULL REFERENCES cip_platform.roles(id) ON DELETE CASCADE,
  tenant_id   UUID NOT NULL,
  granted_by  UUID,
  granted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, role_id)
);
CREATE INDEX IF NOT EXISTS user_role_assignments_role_idx
  ON cip_platform.user_role_assignments (role_id);
CREATE INDEX IF NOT EXISTS user_role_assignments_tenant_idx
  ON cip_platform.user_role_assignments (tenant_id);

ALTER TABLE cip_platform.user_role_assignments ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON cip_platform.user_role_assignments
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID);

-- ============================================================
-- PERMISSION CATALOG (global, no RLS)
-- Populated at runtime by each service registering its permissions
-- (slice 65). Empty here.
-- ============================================================

CREATE TABLE IF NOT EXISTS cip_platform.permission_catalog (
  service       TEXT NOT NULL,
  module        TEXT NOT NULL,
  permission    TEXT NOT NULL,
  description   TEXT,
  registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (service, module, permission)
);
CREATE INDEX IF NOT EXISTS permission_catalog_module_idx
  ON cip_platform.permission_catalog (service, module);
```

---

## Drizzle schema — `packages/platform-core/src/db/schema.ts`

Mirrors the SQL one-to-one. Drizzle table objects exported for typed queries in subsequent slices. Pattern matches `packages/hr-service/src/db/schema.ts` — `pgSchema('cip_platform').table(...)` for each.

No queries are written in this slice. The schema file exists so slice 63 can import typed table objects for the backfill query.

---

## Migration runner — `packages/platform-core/src/db/migrate.ts`

Direct copy of `packages/hr-service/src/db/migrate.ts` with three differences:
- Reads `DATABASE_URL_PLATFORM` instead of `DATABASE_URL_HR`
- `MIGRATIONS_DIR` points at `packages/platform-core/src/db/migrations/`
- Tracking table is `cip_platform.schema_migrations` (NOT `public.schema_migrations` like hr-service). Keeps the two services' migration histories independent so a `cip_platform` schema reset doesn't touch hr-service's tracking, and vice versa.

Same per-migration BEGIN/COMMIT pattern. The runner bootstraps `CREATE SCHEMA IF NOT EXISTS cip_platform` first (in case it's the very first run), then `CREATE TABLE IF NOT EXISTS cip_platform.schema_migrations`, then iterates the migration files.

```typescript
const url = process.env['DATABASE_URL_PLATFORM'];
if (!url) throw new Error('DATABASE_URL_PLATFORM is required');
```

Add `"migrate": "tsx src/db/migrate.ts"` to platform-core's package.json scripts.

---

## DB pool — `packages/platform-core/src/db/index.ts`

```typescript
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';

const url = process.env['DATABASE_URL_PLATFORM'];
if (!url) throw new Error('DATABASE_URL_PLATFORM is required');

export const pool = new Pool({ connectionString: url });
export const db   = drizzle(pool, { schema });
```

Pool is unused in slice 62 — exported so slice 63's tenant routes can `import { db } from '../db'` immediately. Confirm the pool initializes cleanly at platform-core startup as part of acceptance.

---

## Helm + env

The actual hr-service pattern (re-verified) is an `initContainer`, not a Helm pre-install hook. Implementation follows that pattern.

`packages/platform-core/helm/templates/deployment.yaml` — add an initContainer above the main container:

```yaml
spec:
  initContainers:
    - name: migrate
      image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"
      imagePullPolicy: {{ .Values.image.pullPolicy }}
      command: ["node", "dist/db/migrate.js"]
      envFrom:
        {{- toYaml .Values.envFrom | nindent 12 }}
  containers:
    # ... existing container ...
```

`packages/platform-core/Dockerfile` — append before `EXPOSE`:

```dockerfile
COPY --from=builder /app/packages/platform-core/src/db/migrations ./dist/db/migrations
```

`packages/platform-core/helm/values.yaml` — **no change needed**. The deployment already uses `envFrom: secretRef: platform-core-credentials`. Operator adds `DATABASE_URL_PLATFORM` to that existing secret out-of-band; the initContainer reads it via the same envFrom.

For local dev: add `DATABASE_URL_PLATFORM` to `.envrc` pointing at the same Postgres instance as `DATABASE_URL_HR`. Schema separation (`cip_platform`) is the isolation mechanism, not the connection.

---

## Acceptance criteria

1. **`pnpm --filter @cip/platform-core typecheck`** clean. Schema file compiles.

2. **`pnpm --filter @cip/platform-core migrate`** against a clean dev DB:
   - Creates `cip_platform` schema
   - Creates all 10 tables
   - Creates all RLS policies on `users`, `tenant_settings`, `user_role_assignments`
   - Records `001_init.sql` in `cip_platform.schema_migrations`
   - Re-running is a no-op (`[skip] 001_init.sql`)

3. **All tables empty after migration**:
   ```sql
   SELECT count(*) FROM cip_platform.tenants;                -- 0
   SELECT count(*) FROM cip_platform.users;                  -- 0
   SELECT count(*) FROM cip_platform.permission_groups;      -- 0
   SELECT count(*) FROM cip_platform.permission_catalog;     -- 0
   -- ... etc, all 10 tables return 0
   ```

4. **RLS verified on `users`**:
   ```sql
   SET app.current_tenant_id = '00000000-0000-0000-0000-000000000001';
   SELECT count(*) FROM cip_platform.users;  -- succeeds (returns 0)

   RESET app.current_tenant_id;
   SELECT count(*) FROM cip_platform.users;  -- fails with "unrecognized configuration parameter"
   ```

5. **platform-core starts cleanly with `DATABASE_URL_PLATFORM` set**: `pool.query('SELECT 1')` succeeds at boot. (Add a simple `/health/db` endpoint check OR confirm via boot logs.)

6. **`cip_hr` is untouched**: every existing hr-service test passes (`pnpm --filter @cip/hr-service test`); no migration runs against `cip_hr`.

7. **No application reads from `cip_platform` yet**: `grep -r "cip_platform" packages/teams-bot packages/hr-service packages/document-service` returns zero matches except in slice docs.

---

## Test plan

- **Unit**: drizzle schema compiles; types align with SQL columns (no test code, just typecheck).
- **Integration (local Postgres)**:
  1. Drop the dev DB, recreate.
  2. Run `pnpm --filter @cip/hr-service migrate` — confirms cip_hr still works.
  3. Run `pnpm --filter @cip/platform-core migrate` — confirms cip_platform creates cleanly.
  4. Run both again — confirms idempotency.
  5. Manually `INSERT INTO cip_platform.tenants ...` a single row, then `INSERT INTO cip_platform.users ...` referencing it (with `SET app.current_tenant_id`); confirm RLS allows. Roll back.

No production-bound test — the slice ships scaffolding; verification is dev-DB only.

---

## Hard rules summary

- Empty tables only — no seed, no backfill
- No cross-schema FKs
- Mirror final shape, not historical migrations
- RLS at create-time for tenant-scoped tables
- Same Postgres, separate schema, separate connection string
- Idempotent migration (`IF NOT EXISTS` everywhere)
- Match hr-service's drizzle + raw-SQL-migrations pattern

---

## Out of scope (deferred to follow-up slices)

- **Data movement** — slice 63 backfills `tenants*` from `cip_hr`; slice 64 backfills `users` from `cip_hr.employees`.
- **Application reads/writes** — slice 63's HTTP routes are the first consumer.
- **Permission catalog seeding** — slice 65, when each service registers its permissions on startup.
- **`@cip/auth` package** — slice 66 (or wherever the auth API lands).
- **Any platform-core MCP server** — much later (slice 68 in the chain).
- **Splitting `cip_platform` into a separate physical DB** — pure config change later; not now.

---

## Risks

- **Risk**: drizzle's `pgSchema('cip_platform').table(...)` API may differ between drizzle versions; latest-stable could have breaking changes vs. hr-service's installed version.
  - **Mitigation**: at implementation time, run `pnpm view drizzle-orm version` to see the latest stable. Read its release notes for `pgSchema` changes since the version hr-service is on. If breaking, write the new code against the new API and flag a cross-slice note to upgrade hr-service in lockstep.

- **Risk**: an existing dev DB has `cip_platform` schema squatted from a prior aborted attempt.
  - **Mitigation**: `CREATE SCHEMA IF NOT EXISTS` + `CREATE TABLE IF NOT EXISTS` are idempotent. Worst case: `DROP SCHEMA cip_platform CASCADE` and re-run — safe because no service consumes from it yet.

- **Risk**: the helm pre-install hook fails on a fresh install because the `platform-core-db` secret doesn't exist yet.
  - **Mitigation**: the existing tenant-provisioning flow already creates per-service DB secrets; slice 67 will own the platform-core secret creation as part of finishing the Temporal workflow. For this slice, document that the secret must be applied manually before the first `helm install` (one-time op-doc note).

- **Risk**: drift between SQL file and drizzle schema file (someone updates one, forgets the other).
  - **Mitigation**: there's no automated check today and slice 62 doesn't add one. Acknowledged tech debt; the pattern is already this in hr-service.

---

## Cross-slice notes

- Slice 63 (tenant tables move) lands the first writes to `cip_platform.tenants`/`tenant_identity_providers`/`tenant_settings`/`routing_rules` and lights up the new connection pool's actual use.
- Slice 64 (User/Employee split) backfills `cip_platform.users` from `cip_hr.employees` and adds `user_id` FK to the slimmed `cip_hr.employees`. Note: that FK is *intentionally cross-schema as a UUID column*, NOT a Postgres FK, per hard rule 2.
- Slice 65 (auth API + `@cip/auth`) is when permission resolution moves and `permission_catalog` starts getting populated.
- Slice 66 (permission ownership) backfills `roles`, `permission_groups`, `role_groups`, `user_role_assignments` from `cip_hr` equivalents.
- **hr-service library version drift** (cross-slice cleanup candidate): platform-core lands `drizzle-orm@^0.45.2` and `pg@^8.20.0` (latest stable); hr-service is on `drizzle-orm@^0.41.0` and `pg@^8.11.0`. Schema-aware drizzle (`pgSchema`) works in both, so no immediate breakage, but a lockstep upgrade would eliminate the mixed-version surface across the monorepo. Suggest a small standalone slice to bump hr-service after slice 62 ships.

---

## Locked decisions

1. **`tenant_settings` columns** — `litellm_virtual_key`, `channel_config`, `routing_overrides`, `updated_at` (+ `id`, `tenant_id`). No additional columns mirrored at slice-62 time.
2. **Library versions** — latest stable for `drizzle-orm`, `pg`, `@types/pg` at implementation time. Cross-slice note flagged if hr-service needs a lockstep upgrade.
3. **Local dev** — `DATABASE_URL_PLATFORM` and `DATABASE_URL_HR` may point at the same Postgres instance. Schema separation is the isolation mechanism.
4. **Helm secret bootstrap** — `platform-core-db` secret is applied manually before first `helm install`. Documented as a one-time op step; slice 67 automates it.
5. **Migration tracking** — `cip_platform.schema_migrations` (separate from hr-service's `public.schema_migrations`).

Slice is locked.

---

## Implementation status

**Implemented in commit-pending state on 2026-05-06.** Files touched:

- `packages/platform-core/package.json` — added `pg@^8.20.0`, `drizzle-orm@^0.45.2`, `@types/pg@^8.20.0`; added `migrate` script
- `packages/platform-core/src/db/migrations/001_init.sql` — schema + 10 empty tables + RLS
- `packages/platform-core/src/db/migrate.ts` — runner with `cip_platform.schema_migrations` tracking
- `packages/platform-core/src/db/schema.ts` — drizzle table defs via `pgSchema('cip_platform')`
- `packages/platform-core/src/db/index.ts` — lazy pg pool + drizzle client
- `packages/platform-core/helm/templates/deployment.yaml` — added migrate initContainer
- `packages/platform-core/Dockerfile` — COPY .sql migrations into `dist/db/migrations`

Verification:
- ✅ `pnpm install` clean
- ✅ `pnpm --filter @cip/platform-core typecheck` clean
- ✅ `pnpm --filter @cip/platform-core build` produces `dist/db/migrate.js`
- ✅ `pnpm -r run typecheck` clean (no regressions in shared, hr-service, document-service, teams-bot, infra)
- ⏳ DB-level verification (acceptance criteria 2-4) requires `DATABASE_URL_PLATFORM` set + a Postgres instance — operator runs `pnpm --filter @cip/platform-core migrate` against dev DB to confirm.
