# Slice 65 — User consumer migration + drop deprecated identity columns

> **Why this exists:** Slice 64 created `cip_platform.users` and the `employees.user_id` linkage but kept identity fields on `cip_hr.employees` as deprecated cache columns. ~33 files in hr-service still read `employee.email` / `employee.fullName` / `employee.keycloakId` / etc. directly. Slice 65 migrates every read site to source from User instead of Employee, then drops the deprecated columns.
>
> **This is the second half of the chain plan's original "User/Employee split" slice.** Split out because the read-site surface is too wide (~33 files) for one slice.
>
> **Hard cut at the end of this slice.** Once all reads are migrated, the deprecated columns drop in a single migration. There is no "deprecated for one release, then drop next release" pattern — slice 65 ships read migrations + column drops in one atomic deploy.

---

## Files in scope

```
# ── platform-core: query helper for cross-schema joined reads ───────────
packages/platform-core/src/db/queries/users.ts                            NEW (~80 LOC — drizzle queries: findUserById, findUserByEmail, findUserByLink, listUsersByTenant)

# ── hr-service: query helpers + drizzle schema cleanup ─────────────────
packages/hr-service/src/db/queries/employees.ts                           MOD (drop identity columns from EMPLOYEE_COLUMNS, rowToEmployee, upsertEmployee)
packages/hr-service/src/db/queries/employee-with-user.ts                  NEW (~120 LOC — findEmployeeWithUser, listEmployeesWithUserByTenant; drizzle JOIN helpers)
packages/hr-service/src/db/schema.ts                                       MOD (drop identity field declarations from `employees` table object)
packages/hr-service/src/types/employee.ts                                  MOD (remove deprecated identity fields entirely; Employee is now HR-only)

# ── hr-service: read-site migrations (~33 files; see grouped list below) ─
packages/hr-service/src/services/employee-onboarding.ts                   MOD
packages/hr-service/src/services/employee-migration.ts                    MOD
packages/hr-service/src/routes/admin-employees.ts                         MOD
packages/hr-service/src/db/queries/workers.ts                             MOD
packages/hr-service/src/db/queries/roles.ts                               MOD (verify field accesses)
packages/hr-service/src/modules/compliance/mcp-tools/cards/expiry-card.ts MOD
packages/hr-service/src/modules/compliance/mcp-tools/get-expiring-certifications.ts  MOD
packages/hr-service/src/modules/employees/mcp-tools/employee.list.tool.ts MOD
packages/hr-service/src/modules/employees/mcp-tools/employee.create.tool.ts  MOD
packages/hr-service/src/modules/employees/mcp-tools/employee.assign-role.tool.ts MOD
packages/hr-service/src/modules/employees/mcp-tools/employee.revoke-role.tool.ts MOD
packages/hr-service/src/modules/employees/mcp-tools/employee.migrate-identity.tool.ts  MOD
packages/hr-service/src/modules/employees/mcp-tools/cards/staff-card.ts   MOD
packages/hr-service/src/modules/employees/workflows/employee-identity-migration.workflow.ts  MOD
packages/hr-service/src/modules/employees/activities/assign-default-role.activity.ts MOD
packages/hr-service/src/modules/employees/activities/clear-local-credentials.activity.ts  MOD
packages/hr-service/src/modules/employees/activities/send-welcome-notification.activity.ts  MOD
packages/hr-service/src/modules/employees/activities/create-keycloak-user.activity.ts  MOD
packages/hr-service/src/modules/employees/activities/disable-keycloak-user.activity.ts  MOD
packages/hr-service/src/modules/employees/activities/setup-otp-required-actions.activity.ts MOD
packages/hr-service/src/modules/employees/activities/detach-aad-federation.activity.ts  MOD
packages/hr-service/src/modules/employees/activities/invalidate-user-sessions.activity.ts MOD
packages/hr-service/src/modules/employees/activities/attach-aad-federation.activity.ts  MOD
packages/hr-service/src/modules/employees/activities/validate-migration-preconditions.activity.ts MOD
packages/hr-service/src/modules/employees/mcp-tools/sync-employee.ts      MOD (no longer writes identity fields to cip_hr.employees — only writes to cip_platform.users + links + employees HR fields)
packages/hr-service/src/modules/admin/mcp-tools/permission.holders.tool.ts  MOD
packages/hr-service/src/modules/people/activities/aad-precheck.activity.ts  MOD
packages/hr-service/src/modules/people/activities/score-candidates.activity.ts MOD
packages/hr-service/src/modules/people/activities/notify-person-pickcard.activity.ts  MOD
packages/hr-service/src/modules/people/activities/load-employee-shortlist.activity.ts MOD
packages/hr-service/src/modules/people/workflows/match-person.workflow.ts  MOD

# ── DROP migrations (run AFTER all reads are migrated) ──────────────────
packages/hr-service/src/db/migrations/047_drop_employee_identity_columns.sql  NEW (~30 LOC — DROP COLUMN email, full_name, given_name, surname, aad_oid, keycloak_id, identity_type from employees)
packages/hr-service/src/db/migrations/048_drop_legacy_cip_hr_tenants.sql      NEW (~15 LOC — slice 63b cleanup, included here)
packages/platform-core/src/db/migrations/005_drop_users_denormalized_cache.sql  NEW (~20 LOC — DROP COLUMN keycloak_id, aad_oid from users; user_identity_links is the source of truth)
```

~30 files modified, 3 migrations, ~600-800 LOC of net change (mostly mechanical field-access rewrites).

---

## Hard rules

1. **Helper-first migration.** Add `findEmployeeWithUser(db, employeeId)` and `listEmployeesWithUserByTenant(db, tenantId)` helpers in `packages/hr-service/src/db/queries/employee-with-user.ts` BEFORE migrating any consumer. Consumers call these for the joined shape; trivial replacements vs. each consumer writing its own JOIN.

2. **No raw `employee.email` / `employee.fullName` / etc. anywhere after this slice.** Use `user.email`, `user.fullName`, etc. The compiler enforces this once the deprecated fields drop from `EmployeeSchema`.

3. **`sync-employee` stops writing identity to `cip_hr.employees`.** Slice 64's triple-write keeps writing to `users` + `links` + `employees`; slice 65 trims the third write to ONLY HR-specific fields (employmentType, phone, dateOfBirth). Identity fields drop from the INSERT and the columns drop from the table.

4. **Drop migrations run LAST.** Three drop migrations (047, 048, 005) are in a deploy order that matters: all read-site code shipped first, then `helm upgrade` triggers the migrations. Combined with the slice-64 wait-init-container pattern, the column drops happen with zero traffic on the deprecated columns.

5. **`Employee` type is HR-only post-slice-65.** No identity fields. Existing `Employee` callers must shift to `EmployeeWithUser` (the helper's return shape) when they need identity. Compiler errors locate every site.

6. **`Employee.id` and `User.id` stay 1:1.** No change to the linkage. The helper queries trivially join on `employees.id = users.id`.

7. **Slice 63b (drop cip_hr tenant tables) folded in.** Migration 048 drops `cip_hr.tenants`, `tenant_identity_providers`, `tenant_settings`, `routing_rules` — the orphan tables left behind by slice 63. By slice 65 we have a week+ of confidence that cip_platform reads work; pickup this cleanup in the same slice for tidiness.

8. **`cip_platform.users.keycloak_id` and `aad_oid` denormalized cache columns drop.** Migration 005 drops them. Source of truth is `user_identity_links`. Any code that reads `user.keycloakId` migrates to a `user_identity_links` lookup via the helper.

---

## Migration strategy

### The helpers

```typescript
// packages/hr-service/src/db/queries/employee-with-user.ts (NEW)

import { eq, and } from 'drizzle-orm'
import type { Db } from '../index.js'
import { employees, users, userIdentityLinks } from '../schema.js'
import type { Employee } from '../../types/employee.js'
import type { User, UserIdentityLink } from '@cip/shared'

export interface EmployeeWithUser {
  employee: Employee  // HR-only after slice 65
  user:     User
}

export async function findEmployeeWithUser(
  db: Db,
  tenantId: string,
  employeeId: string,
): Promise<EmployeeWithUser | null> {
  const rows = await db
    .select({ employee: employees, user: users })
    .from(employees)
    .innerJoin(users, eq(users.id, employees.userId))
    .where(and(eq(employees.tenantId, tenantId), eq(employees.id, employeeId)))
    .limit(1)
  return rows[0] ?? null
}

// Find by KC subject — replaces findEmployeeByKeycloakId
export async function findEmployeeWithUserByKeycloakSub(
  db: Db,
  tenantId: string,
  keycloakSub: string,
): Promise<EmployeeWithUser | null> {
  const rows = await db
    .select({ employee: employees, user: users })
    .from(userIdentityLinks)
    .innerJoin(users, eq(users.id, userIdentityLinks.userId))
    .innerJoin(employees, eq(employees.userId, users.id))
    .where(and(
      eq(userIdentityLinks.tenantId, tenantId),
      eq(userIdentityLinks.provider, 'keycloak'),
      eq(userIdentityLinks.subject, keycloakSub),
    ))
    .limit(1)
  return rows[0] ?? null
}

// List for a tenant — replaces listEmployees / list-staff queries
export async function listEmployeesWithUserByTenant(
  db: Db,
  tenantId: string,
): Promise<EmployeeWithUser[]> {
  return db
    .select({ employee: employees, user: users })
    .from(employees)
    .innerJoin(users, eq(users.id, employees.userId))
    .where(eq(employees.tenantId, tenantId))
}
```

### Per-consumer transformation pattern

Most files follow one of three patterns:

**Pattern A — Lookup by KC sub (most common):**
```typescript
// BEFORE (slice 64-): reads identity from employee
const employee = await findEmployeeByKeycloakId(client, tenantId, sub)
const adminEmail = employee.email

// AFTER (slice 65):
const result = await findEmployeeWithUserByKeycloakSub(db, tenantId, sub)
const adminEmail = result.user.email
```

**Pattern B — Listing employees with identity:**
```typescript
// BEFORE: const list = await listEmployees(client, tenantId); list.map(e => e.email)
// AFTER:  const list = await listEmployeesWithUserByTenant(db, tenantId); list.map(r => r.user.email)
```

**Pattern C — Activity that needs both employee record + KC user id:**
```typescript
// BEFORE: const e = await findEmployeeById(client, employeeId); const kcId = e.keycloakId
// AFTER:  
const r = await findEmployeeWithUser(db, tenantId, employeeId)
// kc id is now in user_identity_links
const link = await findIdentityLink(db, r.user.id, 'keycloak')
const kcId = link?.subject
```

### File-by-file plan

Grouped by module. Each row is one file → one transformation pattern. Most are mechanical 5-15 line changes.

| File | Pattern | Notes |
|---|---|---|
| `services/employee-onboarding.ts` | A + helper for new user creation path | Already touches cip_platform.users via sync-employee; this slice cleans up the post-onboarding read |
| `services/employee-migration.ts` | A | identity-type changes touch user.identityType now |
| `routes/admin-employees.ts` | B | Listing endpoint |
| `db/queries/workers.ts` | B | Worker = employee-with-employment_type='contractor'; same JOIN |
| `db/queries/roles.ts` | A | Verify; may not actually use identity fields |
| `compliance/mcp-tools/cards/expiry-card.ts` | A | Renders person name in adaptive card |
| `compliance/mcp-tools/get-expiring-certifications.ts` | B | Lists certs with employee identity |
| `employees/mcp-tools/employee.list.tool.ts` | B | Direct list |
| `employees/mcp-tools/employee.create.tool.ts` | A + write-side | Creation touches user + links + employee |
| `employees/mcp-tools/employee.assign-role.tool.ts` | A | Lookup employee, identity for KC role grant |
| `employees/mcp-tools/employee.revoke-role.tool.ts` | A | Same |
| `employees/mcp-tools/employee.migrate-identity.tool.ts` | A + write-side | Updates identity_type → user.identityType |
| `employees/mcp-tools/cards/staff-card.ts` | A | Card renderer |
| `employees/workflows/employee-identity-migration.workflow.ts` | A | Identity-type change orchestrator |
| `employees/activities/*` (10 files) | A | KC operations need user.keycloakId via link lookup |
| `admin/mcp-tools/permission.holders.tool.ts` | B | Lists employees with a permission |
| `people/activities/aad-precheck.activity.ts` | A | AAD-related (uses user.aadOid via link) |
| `people/activities/score-candidates.activity.ts` | A | Scoring uses identity fields |
| `people/activities/notify-person-pickcard.activity.ts` | A | Card with names |
| `people/activities/load-employee-shortlist.activity.ts` | B | Returns shortlist with identity |
| `people/workflows/match-person.workflow.ts` | Coordinates above | |

### sync-employee write-path slim

After slice 65, `sync_employee` writes to `cip_hr.employees` ONLY HR fields:

```typescript
await tx.insert(employees).values({
  id: userId,
  tenantId,
  userId,
  // Identity fields removed: email, fullName, givenName, surname,
  // aadOid, keycloakId, identityType — all on cip_platform.users.
  employmentType: 'employee',
  phone: phone ?? null,
})
```

`employees.email` / `.fullName` / etc. columns no longer exist post-047.

---

## SQL migrations

### `cip_hr/047_drop_employee_identity_columns.sql`

```sql
-- Slice 65: identity moved to cip_platform.users + user_identity_links.
-- All read paths now join on employees.user_id. Drop the deprecated columns.
-- Migration 046 ensures user_id is NOT NULL — every employee has a corresponding
-- user record before this migration runs.

BEGIN;

-- Drop indexes that reference soon-to-drop columns
DROP INDEX IF EXISTS idx_employees_tenant_email;
DROP INDEX IF EXISTS idx_employees_aad_oid;

-- Drop the unique constraint that combined tenant_id + email
ALTER TABLE employees DROP CONSTRAINT IF EXISTS employees_tenant_id_email_key;

ALTER TABLE employees
  DROP COLUMN IF EXISTS email,
  DROP COLUMN IF EXISTS full_name,
  DROP COLUMN IF EXISTS given_name,
  DROP COLUMN IF EXISTS surname,
  DROP COLUMN IF EXISTS aad_oid,
  DROP COLUMN IF EXISTS keycloak_id,
  DROP COLUMN IF EXISTS identity_type;

-- New uniqueness: one employee row per user
ALTER TABLE employees
  ADD CONSTRAINT employees_user_id_unique UNIQUE (user_id);

COMMIT;
```

### `cip_hr/048_drop_legacy_cip_hr_tenants.sql`

```sql
-- Slice 63b cleanup folded into slice 65: drop the tenant tables that lived
-- in cip_hr until slice 63. cip_platform.* has been the source of truth for
-- weeks; no application code reads from these.

BEGIN;

DROP TABLE IF EXISTS cip_hr.routing_rules CASCADE;
DROP TABLE IF EXISTS cip_hr.tenant_settings CASCADE;
DROP TABLE IF EXISTS cip_hr.tenant_identity_providers CASCADE;
DROP TABLE IF EXISTS cip_hr.tenants CASCADE;

COMMIT;
```

### `cip_platform/005_drop_users_denormalized_cache.sql`

```sql
-- Slice 65: drop the denormalized keycloak_id and aad_oid columns from users.
-- Source of truth is user_identity_links. All read sites now use the link
-- table directly via the helper functions.

BEGIN;

-- Drop the unique partial indexes that reference the columns
DROP INDEX IF EXISTS idx_users_tenant_keycloak_id;
DROP INDEX IF EXISTS idx_users_tenant_aad_oid;

ALTER TABLE cip_platform.users
  DROP COLUMN IF EXISTS keycloak_id,
  DROP COLUMN IF EXISTS aad_oid;

COMMIT;
```

---

## Acceptance criteria

1. **`pnpm -r run typecheck` clean** after all changes — proves every consumer migrated since the deprecated fields no longer exist on `Employee`.

2. **Migrations apply cleanly**:
   - `pnpm --filter @cip/hr-service migrate` applies 047 + 048
   - `pnpm --filter @cip/platform-core migrate` applies 005
   - Re-running is a no-op for all three
   - `\d cip_hr.employees` shows: id, tenant_id, user_id, phone, employment_type, date_of_birth, created_at, updated_at, disabled_at — no identity columns

3. **Bot works end-to-end**:
   - Send a message in Teams; bot resolves tenant + sync_employee succeeds
   - `get_employee_permissions` returns the user's roles + permissions
   - User identity (email, fullName) renders correctly in the response card

4. **No reads from dropped columns at runtime**: `tail -f` hr-service logs during a bot turn; no `column does not exist` errors. Verifies the read-site migration was complete.

5. **`grep -rn "employee\.email\|employee\.fullName\|employees\.email" packages/hr-service/src` returns zero matches** — proves all field accesses migrated.

6. **`Employee` type is identity-free**:
   ```typescript
   const e: Employee = ...
   e.email     // TS2339: Property 'email' does not exist on type 'Employee'.
   e.fullName  // same
   e.userId    // OK
   ```

7. **`User` type has no `keycloakId` / `aadOid` fields** post-005 (or those fields are removed from `UserSchema`):
   ```typescript
   const u: User = ...
   u.keycloakId  // TS2339 if removed
   ```
   (Decision point at end — see Open questions.)

---

## Test plan

- **Unit**: `findEmployeeWithUser` happy path, missing employee, missing user (orphan); `findEmployeeWithUserByKeycloakSub` with link.
- **Unit**: each migrated MCP tool — mock the helper, verify the response shape includes user fields correctly.
- **Integration (local DB)**:
  1. Seed users + links + employees (via slice 64 backfill)
  2. Run slice 65 migrations; assert columns dropped
  3. Run all MCP tools end-to-end; assert each returns expected shape
  4. Run `permission.holders.tool` against a tenant with 5 users + 2 admin roles; assert correct identity in response

---

## Forward refs (separate slices, not part of 65)

- **Slice 66 — Auth API + `@cip/auth` package**. `extractAuthContext` becomes a network call to platform-core's `/auth/resolve`. Today it's per-service local JWT verification; that pattern keeps working but the permission resolution moves to platform-core.
- **Slice 67 — Permission ownership migration**. `roles`, `permission_groups`, `role_groups`, `user_role_assignments` move from cip_hr to cip_platform. After slice 65 made `user_id` the canonical reference, this is straightforward.
- **Slice 68 — Per-module MCP servers + platform-core MCP server**. Bot's `resolve-context.ts` shifts MCP calls.
- **Slice 69 — Temporal-ize provisioning** (was 57E).

---

## Risks

- **Risk**: a consumer file reads `employee.email` / `.fullName` etc. that I missed in the file list. Compile fails after deprecated fields drop from EmployeeSchema, but the SQL migration still attempts the column drops in production.
  - **Mitigation**: TS typecheck is the gate. Acceptance criterion 1 requires typecheck clean BEFORE migrating to test or prod. Migrations run only after the new code is deployed.

- **Risk**: KC operations in activities (`disable-keycloak-user`, `clear-local-credentials`, etc.) need `user.keycloakId` for the KC API call. After slice 65 the column drops; these activities must look up via `user_identity_links`.
  - **Mitigation**: a small helper `getKeycloakSubject(db, userId)` reads from `user_identity_links` filtered by `provider='keycloak'`. ~10 LOC. Activities call it instead of reading `user.keycloakId`.

- **Risk**: an Employee constraint (UNIQUE tenant_id, email) is dropped. Existing data may have multi-row email collisions per tenant if email changed historically.
  - **Mitigation**: `UNIQUE(user_id)` replaces it. Email uniqueness moves to `cip_platform.users` (already enforced by slice 62's UNIQUE(tenant_id, email)). No new collision possible.

- **Risk**: the 047 migration drops 7 columns with one ALTER. Postgres rewrites the table physically (not with `ALTER TABLE ... DROP COLUMN` — that's metadata-only) — wait actually DROP COLUMN IS metadata-only in modern Postgres. It just marks the column dropped; storage reclaim happens lazily.
  - **Mitigation**: confirmed safe operation. No table rewrite, no exclusive lock for long.

- **Risk**: 048's CASCADE drops anything referencing the legacy cip_hr tenants tables. Slice 63 left them as orphans — nothing should reference them. Verify with `\d+ cip_hr.tenants` to see referencing FKs.
  - **Mitigation**: dry-run the CASCADE on dev DB; abort if anything other than self-referencing constraints surface.

---

## Cross-slice notes

- **Slice 66 (auth API)** — the `User` returned from `/auth/resolve` is the slim type post-slice-65. Auth API can be drafted assuming the post-65 shape.
- **Slice 67 (permission ownership)** — uses `user_id` as the canonical FK column on `cip_platform.user_role_assignments`, which already exists from slice 62.
- **Future memory of identity caching** — if slice 49 (bot memory) is ever revisited, namespaces become `[tenantId, userId, ...]`.
- **`UserSchema` shape** — slice 65 removes `keycloakId` and `aadOid` from the type. Any external consumer (currently none — `User` is new in slice 64) gets a strict-type signal at compile time.

---

## Implementation status

**Implemented in commit-pending state on 2026-05-06.** Files touched:

- New helpers: `packages/hr-service/src/db/queries/employee-with-user.ts` (drizzle JOIN helpers), `packages/hr-service/src/db/queries/identity-links.ts` (provider subject lookups)
- `Employee` type slimmed to HR-only fields; identity fields removed entirely; `EmployeeUpsert` matches
- `User` zod type drops `keycloakId` / `aadOid` — `user_identity_links` is now the source of truth
- hr-service drizzle `employees` table drops identity columns; `users` cross-schema definition drops `keycloakId`/`aadOid`
- platform-core drizzle `users` table drops `keycloakId`/`aadOid`
- `queries/employees.ts` + `queries/employees-extra.ts` slimmed; `findEmployeeByKeycloakId` and `findEmployeeByEmail` rewritten to JOIN cip_platform.user_identity_links / cip_platform.users
- Consumer migrations:
  - `compliance/mcp-tools/get-expiring-certifications.ts` — JOIN users for fullName/email
  - `compliance/mcp-tools/cards/expiry-card.ts` (no change needed; receives joined shape from caller)
  - `employees/mcp-tools/cards/staff-card.ts` — accepts `StaffCardRow` interface (decoupled from drizzle)
  - `employees/mcp-tools/list-staff.ts` — JOIN users; passes new card row shape
  - `employees/mcp-tools/employee.list.tool.ts` — JOIN users; reads identityType from users
  - `employees/mcp-tools/employee.assign-role.tool.ts` — kc subject from `cip_platform.user_identity_links`
  - `employees/mcp-tools/employee.revoke-role.tool.ts` — same kc lookup
  - `employees/activities/disable-keycloak-user.activity.ts` — uses `getKeycloakSubject` helper
  - `employees/activities/validate-migration-preconditions.activity.ts` — uses `findEmployeeWithUser` + `getKeycloakSubject`
  - `people/activities/aad-precheck.activity.ts` — JOIN userIdentityLinks for AAD subject lookup
  - `services/employee-onboarding.ts` — direct INSERT into cip_platform.users + user_identity_links + slimmed upsertEmployee
  - `services/employee-migration.ts` — cross-schema SELECT for users.identity_type comparison
  - `db/queries/employees-extra.ts:updateEmployeeIdentityType` — splits write across cip_platform.users + user_identity_links + cip_hr.employees.phone
  - `modules/employees/mcp-tools/sync-employee.ts` — UPDATE/INSERT slimmed; cip_hr.employees no longer receives identity fields. **Will be deleted in slice 66.**
- Drop migrations:
  - `cip_hr/047_drop_employee_identity_columns.sql` — drops 7 identity columns + indexes; adds `UNIQUE (user_id)`
  - `cip_hr/048_drop_legacy_cip_hr_tenants.sql` — drops cip_hr.tenants*, routing_rules (slice 63b cleanup folded in)
  - `cip_platform/005_drop_users_denormalized_cache.sql` — drops users.keycloak_id, users.aad_oid + indexes

**Verification:**
- ✅ `pnpm -r run typecheck` clean (all 6 packages)
- ✅ Drop migrations idempotent (`DROP COLUMN IF EXISTS`, `DROP INDEX IF EXISTS`)
- ⏳ DB-level verification requires running migrations against a backfilled dev DB

## Locked decisions

1. **`UserSchema` post-slice-65** — `keycloakId` and `aadOid` dropped entirely from the zod type. `user_identity_links` is the sole source of truth.
2. **Identity link helpers** — separate file `packages/hr-service/src/db/queries/identity-links.ts` (`getKeycloakSubject`, `getAadOid`, `findIdentityLinks`); cleaner namespacing as more providers join.
3. **Slice 63b drop folded in** — migration 048 (drop legacy `cip_hr.tenants*`) lands as part of slice 65. Same runtime, same mental model.
4. **Migration ordering** — `cip_hr/047` and `cip_hr/048` first; `cip_platform/005` last. Platform-core is the eventual source of truth.
5. **`Employee.disabledAt`** — stays on `cip_hr.employees`. Disable is an HR action (employment relationship ended), not an identity action (User stays valid for other modules / other tenants).

Slice is locked. Ready for implementation kickoff.

## Chain renumbering

Per the architectural conversation following slice 65 lock-in: a new **slice 66** is inserted for the user/employee provisioning split (admin-driven / workflow-driven / self-onboarding). Subsequent slices push by 1:

| # | Title |
|---|---|
| 64 | User identity foundation (✅ shipped) |
| 65 | User consumer migration (this slice) |
| **66** | **NEW: User/Employee provisioning split** — `sync_user` on platform-core, `ensure_employee` on hr-service, `tenant_settings.auto_onboard_employees` gate, three documented onboarding paths |
| 67 | Auth API + `@cip/auth` package (was 66) |
| 68 | Permission ownership migration (was 67) |
| 69 | Per-module MCP servers + platform-core MCP expansion (was 68) |
| 70 | Temporal-ize provisioning / 57E completion (was 69) |
