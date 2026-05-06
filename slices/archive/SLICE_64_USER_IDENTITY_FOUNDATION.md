# Slice 64 — User identity foundation (schema split, types, identity links, sync-employee write path)

> **Why this exists:** Phase 2 of Arc 1 auth/identity migration. Today `cip_hr.employees` mixes identity (`keycloak_id`, `aad_oid`, `email`, `full_name`, `given_name`, `surname`, `identity_type`) and HR-specific fields (`employment_type`, `phone`, `date_of_birth`, `disabled_at`). Slice 64 lays the new identity foundation **without breaking any existing read path**:
>
> - Backfill `cip_platform.users` from `cip_hr.employees` (identity columns only)
> - **NEW: `cip_platform.user_identity_links` table** — generic provider-agnostic identity linking. Each user has 1..N rows (one per identity provider: keycloak, aad, google, saml, local_password, etc.). Future-proofs for non-AD systems (D4 lock).
> - Backfill links from existing `users.keycloak_id` and `users.aad_oid`
> - Application enforces "user must have at least one identity link" at the sync-employee write path (D4 lock)
> - Add `cip_hr.employees.user_id` UUID column (NOT a Postgres FK; cross-schema reference)
> - New `User` shared type in `@cip/shared`
> - `Employee` shared type gains `userId`; identity fields stay (deprecated, for now)
> - Update `sync_employee` MCP tool to **write to user, links, AND employee** on every bot turn (this is the canonical entry point for upserts)
> - `cip_hr.employees` identity columns and the ~30 read-site migrations are deferred to **slice 65** (the consumer migration)
> - Helm-level ordering via wait-init-container on hr-service (D3 lock) — hr-service migration waits for `cip_platform/003` and `cip_platform/004` to be recorded as applied before running `cip_hr/046`.
>
> **Scoped narrowly to keep slice 64 small and verifiable.** This is dual-write between cip_hr.employees and cip_platform.users, but only at the *one* canonical write point (sync_employee). All read sites in slice 64 continue reading from cip_hr.employees identity fields. Slice 65 migrates the read sites and then drops the identity columns.
>
> **Why this isn't a hard cut:** the locked decision (D9) was hard cut on application code paths. In slice 64 we do not have parallel code paths — there is exactly one write site (sync_employee) and it writes to both places. That single dual-write entry is what enables the consumer migration in slice 65 to be a clean cut: by the time slice 65 lands, every existing employee already has a corresponding user row.

---

## Files in scope

```
# ── platform-core: backfill + identity links ────────────────────────────
packages/platform-core/src/db/migrations/003_backfill_users.sql           NEW (~60 LOC — INSERT INTO cip_platform.users SELECT identity FROM cip_hr.employees)
packages/platform-core/src/db/migrations/004_user_identity_links.sql      NEW (~70 LOC — CREATE TABLE + backfill from users.keycloak_id and users.aad_oid)
packages/platform-core/src/db/schema.ts                                    MOD (+ userIdentityLinks drizzle table)

# ── hr-service: schema + sync-employee dual write + helm wait ───────────
packages/hr-service/src/db/migrations/046_employees_user_id.sql           NEW (~40 LOC — ADD COLUMN user_id; backfill from cip_platform.users; ALTER TO NOT NULL)
packages/hr-service/src/db/schema.ts                                       MOD (+ users + userIdentityLinks tables from cip_platform; + userId column on employees)
packages/hr-service/src/modules/employees/mcp-tools/sync-employee.ts       MOD (write to user + links + employee within a transaction; enforce ≥1 link)
packages/hr-service/helm/templates/deployment.yaml                         MOD (add wait-for-platform-migrations initContainer before migrate)

# ── shared types ────────────────────────────────────────────────────────
packages/shared/src/types/user.ts                                          NEW (~70 LOC — User + UserIdentityLink + IdentityProvider zod schemas)
packages/shared/src/types/index.ts                                         MOD (export User + UserIdentityLink)
packages/hr-service/src/types/employee.ts                                  MOD (+ userId field; identity fields marked @deprecated; IdentityTypeSchema re-exported from @cip/shared/types/user)
```

~400 LOC of new code + ~5 files modified. **Read sites are NOT touched** in this slice — that's slice 65.

---

## Hard rules

1. **Foundation only — no read-site migrations.** Every existing query that reads `employees.email`, `employees.fullName`, `employees.keycloakId`, etc. continues working untouched after this slice. Slice 65 is the comprehensive read-site migration.

2. **`sync_employee` is the only write-side dual-write.** It writes to `cip_platform.users` first (upsert by `keycloak_id` per tenant), then to `cip_hr.employees` (upsert by email per tenant), within one transaction. If either fails, both roll back.

3. **`user_id` on `employees` is a UUID column, NOT a Postgres FK constraint.** Per slice 62 hard rule 2 (no cross-schema FKs). Application enforces referential integrity (sync-employee inserts the user first, then employee with the user's id).

4. **No identity column drops in this slice.** `cip_hr.employees` keeps `email`, `full_name`, `given_name`, `surname`, `keycloak_id`, `aad_oid`, `identity_type` for now. Their drop happens at the end of slice 65 once all reads have moved.

5. **Backfill before the NOT NULL.** The migration first ADDs the column nullable, runs the backfill UPDATE, then ALTERs to NOT NULL. This is idempotent — re-running is a no-op.

6. **`User` zod schema in `@cip/shared`.** Match the `cip_platform.users` table shape (identity fields only — no HR-specific fields). `keycloakId` and `aadOid` stay on the type as denormalized cache fields (filled by sync-employee from the active links). `UserIdentityLink` is a separate type for the link rows.

7. **`Employee` type stays bloated for slice 64.** The userId field is added; identity fields stay. They're marked `@deprecated — read from User instead (slice 65 migration)` in JSDoc but the runtime behavior is unchanged. Consumers see a strictly-larger type.

8. **Every user has ≥1 identity link.** Enforced at the sync-employee write path: if the inbound JWT has neither `sub` (Keycloak) nor `aad_oid` and no other provider claim, the sync fails before either INSERT runs. Slice 65+ may add a Postgres-level CHECK trigger; for slice 64, the application-layer guard is sufficient.

9. **Identity providers are an open enum.** `user_identity_links.provider` accepts the seeded values today (`keycloak`, `aad`, `google`, `saml`, `local_password`) but no DB-level CHECK constraint — adding a new provider in code shouldn't require a migration. The "valid providers" registry is a constant in `@cip/shared/src/types/user.ts`.

---

## Migrations

### `cip_platform/003_backfill_users.sql`

Cross-schema INSERT inside platform-core's migrate runner. Runs after slice 63's backfill (which is migration 002).

```sql
-- Slice 64: backfill cip_platform.users from cip_hr.employees identity fields.
-- One-time copy. Subsequent inserts come from sync-employee on every bot turn.
-- After slice 65, cip_hr.employees has its identity columns dropped; this
-- backfill is the last time those columns are READ.

BEGIN;

-- 1. Insert one user row per employee.
--    Conflict resolution: source (cip_hr.employees) wins if the user
--    row exists with a divergent value. Preserves cip_platform.users.created_at.
INSERT INTO cip_platform.users
  (id, tenant_id, email, full_name, given_name, surname,
   keycloak_id, aad_oid, identity_type,
   created_at, updated_at)
SELECT
  e.id,                  -- reuse employee.id as user.id (1:1 today)
  e.tenant_id,
  e.email,
  e.full_name,
  e.given_name,
  e.surname,
  e.keycloak_id,
  e.aad_oid,
  e.identity_type,
  e.created_at,
  e.updated_at
FROM cip_hr.employees e
ON CONFLICT (id) DO UPDATE SET
  tenant_id     = EXCLUDED.tenant_id,
  email         = EXCLUDED.email,
  full_name     = EXCLUDED.full_name,
  given_name    = EXCLUDED.given_name,
  surname       = EXCLUDED.surname,
  keycloak_id   = EXCLUDED.keycloak_id,
  aad_oid       = EXCLUDED.aad_oid,
  identity_type = EXCLUDED.identity_type,
  updated_at    = EXCLUDED.updated_at;

COMMIT;
```

**Note:** initial design reuses `employee.id` as the user's id (so user_id == employee_id 1:1). This makes slice 65's read migrations almost mechanical (rename column references; same UUID). A future slice may decouple them when one user spans multiple "employments" across tenants — out of scope for now.

### `cip_platform/004_user_identity_links.sql`

```sql
-- Slice 64: generic identity linking. Replaces the (currently denormalized)
-- users.keycloak_id and users.aad_oid columns with a flexible 1..N model
-- supporting any identity provider (keycloak, aad, google, saml, local_password,
-- and future additions like okta, github, custom OIDC, etc.).
--
-- For slice 64, users.keycloak_id and users.aad_oid stay as denormalized
-- cache columns (sync-employee keeps both in sync). Slice 65+ may drop them
-- once consumers shift to reading from this table.

BEGIN;

CREATE TABLE IF NOT EXISTS cip_platform.user_identity_links (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES cip_platform.users(id) ON DELETE CASCADE,
  tenant_id   UUID NOT NULL,                    -- denormalized for RLS
  provider    TEXT NOT NULL,                    -- 'keycloak'|'aad'|'google'|'saml'|'local_password'|...
  subject     TEXT NOT NULL,                    -- provider-specific external identity id
  metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, provider),                   -- one link per (user, provider)
  UNIQUE (tenant_id, provider, subject)         -- one external subject per provider per tenant
);
CREATE INDEX IF NOT EXISTS idx_uil_provider_subject
  ON cip_platform.user_identity_links(provider, subject);
CREATE INDEX IF NOT EXISTS idx_uil_user_id
  ON cip_platform.user_identity_links(user_id);

ALTER TABLE cip_platform.user_identity_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON cip_platform.user_identity_links
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID);

-- Backfill from users.keycloak_id (one link per user with non-null kc id)
INSERT INTO cip_platform.user_identity_links (user_id, tenant_id, provider, subject)
SELECT id, tenant_id, 'keycloak', keycloak_id
FROM cip_platform.users
WHERE keycloak_id IS NOT NULL
ON CONFLICT (user_id, provider) DO NOTHING;

-- Backfill from users.aad_oid
INSERT INTO cip_platform.user_identity_links (user_id, tenant_id, provider, subject)
SELECT id, tenant_id, 'aad', aad_oid
FROM cip_platform.users
WHERE aad_oid IS NOT NULL
ON CONFLICT (user_id, provider) DO NOTHING;

COMMIT;
```

After 003 + 004 run, every existing user has 1..2 link rows (depending on whether they had keycloak_id/aad_oid populated).

### `cip_hr/046_employees_user_id.sql`

Runs as part of hr-service's normal migrate sequence. **Order constraint: cip_platform/003 AND 004 must complete before this migration runs.** Slice 64 adds a wait-init-container to hr-service's deployment that polls `cip_platform.schema_migrations` for both migration names before running the migrate command. See the Helm section below.

```sql
-- Slice 64: link employees to users in cip_platform.
-- user_id is a UUID column, not a Postgres FK (per cross-schema constraint
-- avoidance). Application code (sync-employee) enforces the integrity.

BEGIN;

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS user_id UUID;

-- Backfill from cip_platform.users using the 1:1 id mapping established by
-- cip_platform/003_backfill_users.sql.
UPDATE employees e
   SET user_id = u.id
  FROM cip_platform.users u
 WHERE e.id = u.id
   AND e.user_id IS NULL;

-- Defensive: if any employee row has no matching user (shouldn't happen
-- given the 1:1 backfill), surface the failure here rather than letting
-- the NOT NULL ALTER do it cryptically.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM employees WHERE user_id IS NULL) THEN
    RAISE EXCEPTION 'employees.user_id has NULL values after backfill — cip_platform.users incomplete?';
  END IF;
END $$;

ALTER TABLE employees
  ALTER COLUMN user_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_employees_user_id ON employees(user_id);

COMMIT;
```

---

## `@cip/shared/src/types/user.ts`

```typescript
import { z } from 'zod';

// Open enum: code can add new providers without a DB migration. Adding
// to this list is the only place to wire a new identity system in.
export const IDENTITY_PROVIDERS = [
  'keycloak',
  'aad',
  'google',
  'saml',
  'local_password',
] as const;
export const IdentityProviderSchema = z.enum(IDENTITY_PROVIDERS);
export type IdentityProvider = z.infer<typeof IdentityProviderSchema>;

// identity_type stays for now (used in HR onboarding flow). It says what
// kind of user this is at registration time; the user's actual login
// linkages are in user_identity_links.
export const IdentityTypeSchema = z.enum(['aad_federated', 'field_employee', 'local_password']);
export type IdentityType = z.infer<typeof IdentityTypeSchema>;

export const UserSchema = z.object({
  id:           z.string().uuid(),
  tenantId:     z.string().uuid(),
  email:        z.string().email(),
  fullName:     z.string().min(1),
  givenName:    z.string().nullable(),
  surname:      z.string().nullable(),
  // Slice 64: denormalized cache columns for the most common providers.
  // The source of truth is user_identity_links. Slice 65+ may drop these.
  keycloakId:   z.string().nullable(),
  aadOid:       z.string().nullable(),
  identityType: IdentityTypeSchema,
  createdAt:    z.string(),
  updatedAt:    z.string(),
});
export type User = z.infer<typeof UserSchema>;

export const UserIdentityLinkSchema = z.object({
  id:         z.string().uuid(),
  userId:     z.string().uuid(),
  tenantId:   z.string().uuid(),
  provider:   IdentityProviderSchema,
  subject:    z.string().min(1),
  metadata:   z.record(z.unknown()).default({}),
  createdAt:  z.string(),
  updatedAt:  z.string(),
});
export type UserIdentityLink = z.infer<typeof UserIdentityLinkSchema>;
```

Exported from `@cip/shared/src/types/index.ts`. `IdentityTypeSchema` is re-exported from `hr-service/src/types/employee.ts` for backwards compat.

---

## `Employee` type changes

In wherever `Employee` is currently defined (`packages/hr-service/src/types/employee.ts` per earlier investigation):

```typescript
export const EmployeeSchema = z.object({
  id:       z.string().uuid(),
  tenantId: z.string().uuid(),
  userId:   z.string().uuid(),  // NEW (slice 64)

  // Identity fields. Stay for slice 64; slice 65 drops them after the
  // read-site migration completes. Read from User instead going forward.
  /** @deprecated Slice 64: read from User. Will be dropped in slice 65. */
  email:        z.string().email(),
  /** @deprecated Slice 64: read from User. Will be dropped in slice 65. */
  fullName:     z.string().min(1),
  /** @deprecated Slice 64: read from User. */
  givenName:    z.string().nullable(),
  /** @deprecated Slice 64: read from User. */
  surname:      z.string().nullable(),
  /** @deprecated Slice 64: read from User. */
  aadOid:       z.string().nullable(),
  /** @deprecated Slice 64: read from User. */
  keycloakId:   z.string().nullable(),
  /** @deprecated Slice 64: read from User. */
  identityType: IdentityTypeSchema,

  // HR-specific (stay):
  employmentType: EmploymentTypeSchema,
  phone:          z.string().nullable(),
  dateOfBirth:    z.string().nullable(),
  // ... other HR fields
});
```

---

## hr-service drizzle schema

`packages/hr-service/src/db/schema.ts` — three changes:

```typescript
// 1. Import users from cip_platform (mirror the slice-63 tenantSettings pattern)
export const users = cipPlatform.table('users', {
  id:           uuid('id').primaryKey().defaultRandom(),
  tenantId:     uuid('tenant_id').notNull(),
  email:        text('email').notNull(),
  fullName:     text('full_name').notNull(),
  givenName:    text('given_name'),
  surname:      text('surname'),
  keycloakId:   text('keycloak_id'),
  aadOid:       text('aad_oid'),
  identityType: text('identity_type').notNull(),
  createdAt:    timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt:    timestamp('updated_at', { withTimezone: true }).defaultNow(),
})

// 2. New: user_identity_links cross-schema reference
export const userIdentityLinks = cipPlatform.table('user_identity_links', {
  id:         uuid('id').primaryKey().defaultRandom(),
  userId:     uuid('user_id').notNull(),
  tenantId:   uuid('tenant_id').notNull(),
  provider:   text('provider').notNull(),
  subject:    text('subject').notNull(),
  metadata:   jsonb('metadata').notNull().default({}),
  createdAt:  timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:  timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

// 3. Add userId to employees (column added by 046; just expose it in TS)
export const employees = pgTable('employees', {
  // ... existing fields ...
  userId: uuid('user_id').notNull(),  // NEW (slice 64)
})
```

Existing consumers reading `employees.email` etc. continue working — those columns still exist on the table.

---

## `sync_employee` triple write

`packages/hr-service/src/modules/employees/mcp-tools/sync-employee.ts` — the bot's per-turn upsert. After slice 64, it inserts/updates **user + N links + employee** within one transaction:

```typescript
await withTenantRLS(db, tenantId, async (tx) => {
  // Build the link set first — this is the "≥1 identity" check (Hard rule 8).
  const linkValues: Array<{ provider: IdentityProvider; subject: string }> = []
  if (keycloakUserId) linkValues.push({ provider: 'keycloak', subject: keycloakUserId })
  if (aadOid)         linkValues.push({ provider: 'aad',      subject: aadOid })
  // Future: google, saml, etc. plug in here as they're integrated.

  if (linkValues.length === 0) {
    throw new Error('sync_employee: user has no identity link (keycloak_id, aad_oid, ...) — refusing to create orphan user')
  }

  // 1. Upsert into cip_platform.users (denormalized cache columns kept for slice 64)
  const userRow = await tx
    .insert(users)
    .values({
      id: keycloakUserId ?? aadOid!,  // 1:1 with employee.id; pick the most stable available
      tenantId,
      email,
      fullName,
      givenName: givenName ?? null,
      surname:   surname  ?? null,
      keycloakId: keycloakUserId ?? null,
      aadOid:     aadOid ?? null,
      identityType,
    })
    .onConflictDoUpdate({
      target: [users.tenantId, users.keycloakId],  // unique partial idx from slice 62
      set: {
        email, fullName, givenName, surname, aadOid, identityType,
        updatedAt: sql`NOW()`,
      },
    })
    .returning()

  const userId = userRow[0].id

  // 2. Upsert N identity links (one per provider seen in this sync)
  for (const { provider, subject } of linkValues) {
    await tx
      .insert(userIdentityLinks)
      .values({ userId, tenantId, provider, subject })
      .onConflictDoUpdate({
        target: [userIdentityLinks.userId, userIdentityLinks.provider],
        set: { subject, updatedAt: sql`NOW()` },
      })
  }

  // 3. Upsert into cip_hr.employees with the user_id linkage
  await tx
    .insert(employees)
    .values({
      id: userId,             // 1:1 with users.id
      tenantId,
      userId,                 // explicit linkage
      email, fullName, givenName, surname,
      keycloakId: keycloakUserId,
      aadOid:     aadOid ?? null,
      identityType,
      employmentType: employmentType ?? 'employee',
      phone: phone ?? null,
    })
    .onConflictDoUpdate({
      target: [employees.tenantId, employees.email],
      set: {
        fullName, givenName, surname, aadOid,
        identityType,
        userId,
        updatedAt: sql`NOW()`,
      },
    })
})
```

**This triple-write is what locks in the foundation.** Every fresh sync after slice 64 keeps user + links + employee coherent. The "≥1 link" check fails the entire transaction before any write — no orphan users.

## Helm: wait-init-container on hr-service

`packages/hr-service/helm/templates/deployment.yaml` — add a wait-init-container BEFORE the existing migrate container:

```yaml
spec:
  initContainers:
    # Slice 64: wait until cip_platform's slice-64 migrations have been
    # recorded as applied. Without this, hr-service's 046 migration
    # could race ahead of the platform-core backfills and find an empty
    # cip_platform.users — fails the NOT NULL ALTER cryptically.
    - name: wait-for-platform-migrations
      image: postgres:16-alpine
      command:
        - sh
        - -c
        - |
          set -e
          REQUIRED="003_backfill_users.sql 004_user_identity_links.sql"
          for migration in $REQUIRED; do
            echo "[wait] checking cip_platform.schema_migrations for $migration..."
            until psql "$DATABASE_URL_HR" -tAc \
              "SELECT 1 FROM cip_platform.schema_migrations WHERE migration = '$migration'" \
              2>/dev/null | grep -q '^1$'; do
              echo "[wait]   not yet — sleeping 3s"
              sleep 3
            done
            echo "[wait] $migration confirmed applied"
          done
          echo "[wait] all slice-64 platform-core migrations applied; proceeding"
      envFrom:
        {{- toYaml .Values.envFrom | nindent 12 }}

    # Existing migrate initContainer
    - name: migrate
      image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"
      imagePullPolicy: {{ .Values.image.pullPolicy }}
      command: ["node", "dist/db/migrate.js"]
      envFrom:
        {{- toYaml .Values.envFrom | nindent 12 }}
```

initContainers run **sequentially** within a pod, so `migrate` doesn't start until `wait-for-platform-migrations` exits 0. The wait container exits cleanly only after both `003_backfill_users.sql` and `004_user_identity_links.sql` are recorded in `cip_platform.schema_migrations`.

Operator deploy order:
1. `helm upgrade platform-core` — applies 003 + 004
2. `helm upgrade hr-service` — wait-init-container confirms; migrate runs 046

The wait pattern works regardless of order — if the operator runs hr-service first, its pods sit in `Init:0/2` state until platform-core lands its migrations. Helm `--atomic --timeout` bounds the wait.

---

## Acceptance criteria

1. **`pnpm -r run typecheck` clean** after all changes.

2. **`pnpm --filter @cip/platform-core migrate`** applies `003_backfill_users.sql`. Verify:
   - `SELECT count(*) FROM cip_platform.users` matches `SELECT count(*) FROM cip_hr.employees`
   - Every employee row has a corresponding user row with the same `id`
   - Re-running migrate is a no-op (`[skip] 003_backfill_users.sql`)

3. **`pnpm --filter @cip/hr-service migrate`** applies `046_employees_user_id.sql`. Verify:
   - `SELECT count(*) FROM employees WHERE user_id IS NULL` returns 0
   - The migration's `RAISE EXCEPTION` triggered IFF cip_platform/003 hadn't run first (negative test)
   - Re-running migrate is a no-op

4. **`sync_employee` writes to both tables**. After a bot turn:
   - The user appears in `cip_platform.users` with the right tenant + keycloak_id
   - The employee appears in `cip_hr.employees` with `user_id` matching `cip_platform.users.id`
   - Re-running the sync is idempotent (UPSERT semantics)

5. **No regression in existing read sites**: `pnpm --filter @cip/hr-service test` passes; `find_employee` / `get_employee_permissions` / `permission.holders.tool` etc. still return identity fields from `cip_hr.employees`.

6. **`User` type is exported and importable**:
   - `import { User, UserSchema } from '@cip/shared/src/types/user.js'` works
   - `UserSchema.parse(row)` validates a row from `cip_platform.users`

7. **Tenant isolation maintained**: a user from tenant A is invisible to a session set to tenant B. Verify with the existing RLS test pattern.

---

## Test plan

- **Unit**: `UserSchema.parse()` — happy path, missing required fields, invalid email, invalid identityType
- **Unit**: sync-employee — verify both tables get rows; verify rollback if either INSERT fails
- **Integration (local DB)**:
  1. Seed `cip_hr.employees` with 5 fake employees (mix of identity_types)
  2. Run platform-core/003 migration; assert 5 users exist in `cip_platform.users`
  3. Run hr-service/046 migration; assert all 5 employees have `user_id` populated
  4. Call `sync_employee` for a 6th user (KC newly-onboarded); assert both tables update
  5. Negative: temporarily make cip_platform.users RLS reject; sync-employee should fail with both tables rolled back

---

## Forward refs (separate slices, not part of 64)

- **Slice 65 — Consumer migration (was the second half of the chain's slice 64)**. Migrates ~25-30 read sites in hr-service to read identity from `cip_platform.users` via cross-schema JOIN. After slice 65 ships, drops `email`, `full_name`, `given_name`, `surname`, `keycloak_id`, `aad_oid`, `identity_type` columns from `cip_hr.employees`. **This was originally a single slice 64 in the chain plan; split because the consumer surface is too wide for one slice.**
- **Slice 66 — Auth API + `@cip/auth`** (renumbered from previous slice 65). When `extractAuthContext` and permission resolution move to platform-core. Uses the `User` type as its return shape.
- **Slice 67 — Permission ownership migration** (renumbered).
- **Slice 68 — Per-module MCP servers + platform-core MCP** (renumbered).
- **Slice 69 — Temporal-ize provisioning** (renumbered).

**Updated chain numbering: Arc 1 grows from 7 slices to 8.**

---

## Risks

- **Risk**: backfill assumes 1:1 employee↔user. If `cip_hr.employees` has duplicates (same `id` somehow), the backfill INSERT/UPDATE collapses them.
  - **Mitigation**: `employees.id` is a primary key, so duplicates are impossible. Tested by acceptance criterion 2 (counts match).

- **Risk**: hr-service's migrate runs before platform-core's, finding `cip_platform.users` empty, and the NOT NULL ALTER fails on existing employees with no user.
  - **Mitigation**: the migration's defensive `RAISE EXCEPTION` aborts the rollout cleanly with a clear message. Helm `--atomic` rolls back; operator runs platform-core migrate manually then retries.
  - **Long-term mitigation**: slice 67 (or wherever) introduces explicit Helm hook ordering. For now, the failure mode is loud, not silent.

- **Risk**: sync-employee transaction split across schemas. Postgres handles cross-schema transactions natively (same DB), but if/when DBs split (future), this dual-write becomes a 2PC problem.
  - **Mitigation**: not relevant today (same DB). When DBs split, sync-employee shifts to write to `cip_platform.users` via HTTP API; the API call's success becomes the precondition for the local employee insert. Out of scope for slice 64.

- **Risk**: `Employee` type having both `userId` AND deprecated identity fields confuses callers.
  - **Mitigation**: `@deprecated` JSDoc surfaces in IDEs. Slice 65 drops the fields; the warning is temporary.

- **Risk**: `IdentityTypeSchema` is currently defined in two places (`@cip/shared/types/tenant.ts` for IDP and `hr-service/types/employee.ts` for the user identity type). Re-exporting from `user.ts` may collide.
  - **Mitigation**: verify which file owns `IdentityTypeSchema` for users; consolidate in `user.ts` and re-export. ~10 LOC of careful re-export.

---

## Cross-slice notes

- Slice 65 is the read-site migration. Without slice 65, hr-service's bloated `Employee` type stays bloated and the deprecated JSDoc warnings linger.
- Slice 66 (auth API) returns `User` (not `Employee`) as its identity payload. Slice 64 makes that possible.
- Slice 67 (permission ownership) moves `user_role_assignments` from cip_hr to cip_platform with `user_id` as the FK. Slice 64's user_id linkage is the prerequisite.
- Slice 49 (memory) was paused; if revisited, its namespace `[tenantId, employeeId, ...]` should become `[tenantId, userId, ...]` post-slice-64.

---

## Locked decisions

1. **`employee.id` reused as `user.id`** (1:1 mapping) — slice 65 read migration becomes mechanical column rename.
2. **`IdentityTypeSchema` lives in `@cip/shared/src/types/user.ts`** — re-exported from `hr-service/src/types/employee.ts` for backwards compat.
3. **Helm-level ordering** — wait-init-container on hr-service polls `cip_platform.schema_migrations` for `003_backfill_users.sql` AND `004_user_identity_links.sql` before the existing migrate container runs. Works regardless of `helm upgrade` order.
4. **User must have ≥1 identity link, design for non-AD providers** — generic `cip_platform.user_identity_links` table introduced in slice 64; supports `keycloak`, `aad`, `google`, `saml`, `local_password` (open enum, code-side registry in `@cip/shared/src/types/user.ts`). sync-employee enforces ≥1 link before any write. Denormalized `keycloak_id` / `aad_oid` columns stay on `users` for slice 64; slice 65+ may drop them.
5. **Slice scope split** — ~25-30 read-site changes deferred to slice 65 (renumbered chain plan).

Slice is locked.

---

## Implementation status

**Implemented in commit-pending state on 2026-05-06.** Files touched:

**platform-core (new):**
- `packages/platform-core/src/db/migrations/003_backfill_users.sql` — INSERT INTO users SELECT identity FROM cip_hr.employees, ON CONFLICT DO UPDATE
- `packages/platform-core/src/db/migrations/004_user_identity_links.sql` — CREATE TABLE + RLS + backfill from users.keycloak_id and users.aad_oid
- `packages/platform-core/src/db/schema.ts` — added `userIdentityLinks` cipPlatform.table

**hr-service (new + mod):**
- `packages/hr-service/src/db/migrations/046_employees_user_id.sql` — ADD COLUMN user_id, backfill from cip_platform.users 1:1, NOT NULL ALTER, defensive RAISE EXCEPTION
- `packages/hr-service/src/db/schema.ts` — added `users` + `userIdentityLinks` cross-schema tables, added `userId` column to `employees`
- `packages/hr-service/src/db/queries/employees.ts` — EMPLOYEE_COLUMNS includes `user_id`, rowToEmployee parses it, upsertEmployee passes it in INSERT (now 12 columns)
- `packages/hr-service/src/types/employee.ts` — re-exports IdentityTypeSchema from @cip/shared, adds `userId` field, marks identity fields @deprecated
- `packages/hr-service/src/services/employee-onboarding.ts` — upsertEmployee call includes `userId: id` (1:1)
- `packages/hr-service/src/modules/employees/mcp-tools/sync-employee.ts` — triple-write: user-by-keycloak-link lookup → upsert user → upsert links (1..N) → upsert employee. Hard rule 8 enforced: throws if no identity links derivable from JWT.
- `packages/hr-service/helm/templates/deployment.yaml` — added `wait-for-platform-migrations` initContainer (postgres:16-alpine; polls cip_platform.schema_migrations for both 003 and 004 before letting `migrate` run).

**shared (new + mod):**
- `packages/shared/src/types/user.ts` — UserSchema + UserIdentityLinkSchema + IdentityTypeSchema (canonical) + IdentityProviderSchema + IDENTITY_PROVIDERS open-enum constant
- `packages/shared/src/index.ts` — `export * from './types/user.js'`

**Type fixes encountered during implementation:**
- `@cip/shared/dist/types/user.{js,d.ts}` had to be rebuilt after adding `user.ts` (ESM `exports` map resolves via dist; clean rebuild required)
- `EmployeeUpsertSchema` requiring `userId` rippled to `employee-onboarding.ts` (passes `userId: id`) and `upsertEmployee` SQL (12 placeholder positions, EMPLOYEE_COLUMNS + INSERT updated)

**Verification:**
- ✅ `pnpm --filter @cip/shared build` (rebuilt from clean)
- ✅ `pnpm -r run typecheck` clean (all 6 packages)
- ⏳ DB-level: requires `cip_hr.employees` rows to backfill from. Operator runs `pnpm --filter @cip/platform-core migrate` then `pnpm --filter @cip/hr-service migrate`.
- ⏳ The wait-init-container can be exercised by intentionally running hr-service migrate before platform-core's — should poll until cip_platform/003+004 land.
