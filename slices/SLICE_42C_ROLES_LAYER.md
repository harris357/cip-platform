# Slice 42C — Role layer (cross-module composition over permission groups)

> **Prerequisite:** Slice 42A complete (`permission_groups` exists with `service` + `module` columns; multi-module legacy rows still have `module = 'general'`).
> **Successor:** Slice 42B depends on 42C — admin bootstrap assigns a ROLE, not a group.
> **Package:** `@cip/hr-service`, `@cip/platform-core`
> **Verify:** `pnpm -r run typecheck && bash scripts/bootstrap.sh` (then SQL spot-check of role + group + assignment chain)

---

## The hierarchy this slice completes

```
Service       Keycloak realm role     'hr' / 'employee'           coarse access gate
   ↓
Role          CIP business concept     'hr_manager'                THIS SLICE
   ↓
Group         module-scoped bundle     'cert_admin' (cert mod)     Slice 42A
   ↓
Permission    atomic code              'cert.submit'               Slice 42A — catalog
   ↓
Tool          MCP function             process_document            actual work
```

42C introduces the **Role** layer on top of 42A's groups. Roles are how operators model job functions ("HR Manager", "Field Worker"); groups are reusable building blocks within a role.

---

## Why This Slice Exists

After 42A, employees are assigned directly to permission groups via `employee_group_assignments`. That works, but two real-world patterns make it awkward:

1. **A job function spans modules.** An "HR Manager" needs cert-module groups + employee-module groups + compliance-module groups. Today, the only way to express that is one cross-module group containing all those permissions — which is what `hr_standard` etc. did pre-42A and now sit as `module='general'` placeholder rows. That's a flat, non-composable representation.

2. **Groups should be reusable building blocks.** The `cert_admin` group ("everything in the cert module") is useful in TWO different job functions: "HR Manager" and "Cert Specialist." With direct group assignment, each employee gets the group attached individually. With a role layer, define `cert_admin` once, reference it from BOTH the HR Manager role AND the Cert Specialist role. Operators add a new persona by composing existing groups, not by enumerating permissions.

Industry parallel: **NIST RBAC1 hierarchical roles + AWS IAM separation of policies/groups/roles**. Groups are reusable bundles; roles are job functions composed from groups. CIP follows the same pattern.

42C delivers:
- `roles` table (the new business-concept role)
- `role_groups` join (a role contains N groups)
- `employee_role_assignments` (replaces 42A's `employee_group_assignments`)
- Resolver chains employee → role → groups → permissions, expanding globs at the end (42A's machinery)
- Migration that splits 42A's `module='general'` rows into per-module groups + a composing role
- `keycloak_role` column moves from `permission_groups` to `roles` (where it semantically belongs)
- Helper renames: `grantRoleByCode` → `assignRoleToEmployee` (now operating on roles, name is accurate)

Hard rule: **after 42C, no `permission_groups` row has `module = 'general'`**. Every group is single-module. Cross-module bundling lives in `roles`.

---

## What 42C DOES

- Adds `roles`, `role_groups`, `employee_role_assignments` tables
- Migrates 42A's `module='general'` groups: splits each into per-module groups + creates a role of the same code that contains them
- Migrates `employee_group_assignments` rows → `employee_role_assignments` (each employee's existing group assignment becomes a role assignment to the role with the matching code)
- Drops `employee_group_assignments` (no longer used; role-assignment is the only path)
- Moves `keycloak_role` column from `permission_groups` to `roles`
- Updates resolver (`getPermissionsForEmployee`) to chain through three layers
- Renames helpers: `grantRoleByCode` → `assignRoleToEmployee`, etc. — now semantically accurate
- Updates MCP tools (`employee.grant-permission`, `employee.revoke-permission`, `get-employee-permissions`) to operate on roles
- Updates platform-core's `init-tenant-database.activity.ts` to seed the new shape (groups + roles + role_groups) for new tenants

## What 42C DOES NOT do (deferred)

- **No admin bootstrap** — Slice 42B uses 42C's primitives.
- **No KC realm role auto-assignment** — also Slice 42B.
- **No removal of `permission_groups.capabilities` legacy column** — defer to a future cleanup slice once we're sure nothing reads it.
- **No CHECK constraint enforcing `module IN (real values)`.** Soft enum via the catalog table is enough for now.

---

## What You Are Building

```
packages/hr-service/src/
  db/
    migrations/
      012_roles_layer.sql                     ← NEW: roles + role_groups + employee_role_assignments
                                                  + split 'general' groups + move keycloak_role
                                                  + drop employee_group_assignments
    queries/
      permissions.ts                          ← MOD: chained resolver + helpers renamed *Role* operating on roles
      roles.ts                                ← NEW (extracted from permissions.ts): role-level helpers
    schema.ts                                 ← MOD: roles, roleGroups, employeeRoleAssignments;
                                                  drop employeeGroupAssignments; move keycloakRole
  modules/employees/mcp-tools/
    employee.grant-permission.tool.ts         ← MOD: now assigns a ROLE (parameter name 'role' is now accurate)
    employee.revoke-permission.tool.ts        ← MOD: revokes a ROLE
    get-employee-permissions.tool.ts          ← MOD: queries through role layer

packages/platform-core/src/
  activities/
    init-tenant-database.activity.ts          ← MOD: seed per-module groups + roles + role_groups for new tenants

slices/
  SLICE_42C_ROLES_LAYER.md                    ← this doc
```

---

## Read Before Writing

- `slices/SLICE_42A_PERMISSION_GROUPS_SCHEMA.md` — the foundation 42C builds on
- `packages/hr-service/src/db/queries/permissions.ts` — 5 helpers, all touched by the rename + chain
- `packages/hr-service/src/db/schema.ts` — Drizzle definitions for permissionGroups + employeeGroupAssignments
- `packages/hr-service/src/modules/employees/mcp-tools/employee.grant-permission.tool.ts`
- `packages/hr-service/src/modules/employees/mcp-tools/employee.revoke-permission.tool.ts`
- `packages/hr-service/src/modules/employees/mcp-tools/get-employee-permissions.tool.ts`
- `packages/platform-core/src/activities/init-tenant-database.activity.ts`

Do **not** modify KC-realm-role code (`employee.assign-role.tool.ts`, `employee.revoke-role.tool.ts`). Different concept.

---

## Hard Rules (Seven Non-Negotiables)

1. **Every `permission_groups` row is single-module after 42C.** No `module = 'general'` should remain. The migration splits all transitional rows; verify with `SELECT count(*) FROM permission_groups WHERE module = 'general'` returning 0 post-migration.
2. **Cross-module access is expressed through roles, never groups.** A role contains multiple module-scoped groups via `role_groups`. Operators creating new groups must pick a real module. Operators creating cross-functional access bundles use roles.
3. **Roles are additive — multiple per employee allowed.** `employee_role_assignments` has no uniqueness beyond `(employee_id, role_id)`. Resolver unions permissions across all assigned roles.
4. **`keycloak_role` lives on `roles` only.** A role implies which KC realm role the employee should also have. Groups don't know about KC; they're just permission bundles.
5. **Glob expansion happens AFTER role/group flattening.** Resolver chain: employee → roles → groups → raw permissions (literals + globs) → expand globs against catalog → dedupe. Globs are evaluated at the leaf.
6. **`tenantId` flows through every join.** Roles are tenant-scoped; their constituent groups are tenant-scoped; the catalog is platform-wide but never crosses service boundaries. No accidental cross-tenant leakage.
7. **Migration is idempotent and reversible-ish.** Re-running 012 on a fully-migrated DB = no-op. The migration keeps split groups + roles around even if it can't find `module='general'` rows on re-run.

---

## Migration: `012_roles_layer.sql`

The big one. Five steps, all in one transaction so the system never sees a half-state.

```sql
BEGIN;

-- ─── 1. Create new tables ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS roles (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL,
  code         TEXT NOT NULL,
  label        TEXT NOT NULL,
  description  TEXT,
  keycloak_role TEXT NOT NULL,                  -- 'hr' or 'employee' — implies which realm role
  is_system_role BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, code)
);

CREATE TABLE IF NOT EXISTS role_groups (
  role_id  UUID NOT NULL REFERENCES roles(id)              ON DELETE CASCADE,
  group_id UUID NOT NULL REFERENCES permission_groups(id)  ON DELETE CASCADE,
  PRIMARY KEY (role_id, group_id)
);

CREATE TABLE IF NOT EXISTS employee_role_assignments (
  employee_id UUID NOT NULL,
  role_id     UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  granted_by  UUID,
  granted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (employee_id, role_id)
);

CREATE INDEX IF NOT EXISTS employee_role_assignments_role_idx
  ON employee_role_assignments (role_id);

-- ─── 2. Split each 'general' permission_groups row into per-module groups ────
--
-- For each transitional row (e.g. hr_standard with permissions
-- ['employee.create', 'employee.list', 'cert.approve', 'compliance.view']):
--   1. Group permissions by module prefix
--   2. Create one new permission_groups row per module with code
--      '<original_code>__<module>' and the module-specific permissions
--   3. Mark the original row for deletion (we keep it around as a 'role
--      shell' for step 3 to use)

-- Insert the per-module split groups.
INSERT INTO permission_groups (
  tenant_id, service, module, code, keycloak_role, label, permissions, is_system_role
)
SELECT
  pg.tenant_id,
  pg.service,
  split_part(p, '.', 1)                        AS module,
  pg.code || '__' || split_part(p, '.', 1)     AS code,    -- 'hr_standard__cert' etc.
  pg.keycloak_role,
  pg.label || ' (' || split_part(p, '.', 1) || ' module)' AS label,
  jsonb_agg(p)                                 AS permissions,
  pg.is_system_role
FROM permission_groups pg, jsonb_array_elements_text(pg.permissions) AS p
WHERE pg.module = 'general'
GROUP BY pg.tenant_id, pg.service, pg.code, pg.keycloak_role, pg.label, pg.is_system_role,
         split_part(p, '.', 1)
ON CONFLICT (tenant_id, service, module, code) DO UPDATE
  SET permissions = EXCLUDED.permissions;

-- ─── 3. Create a role for each original 'general' group ──────────────────────

INSERT INTO roles (tenant_id, code, label, description, keycloak_role, is_system_role)
SELECT tenant_id, code, label, description, keycloak_role, is_system_role
FROM permission_groups
WHERE module = 'general'
ON CONFLICT (tenant_id, code) DO UPDATE
  SET label = EXCLUDED.label,
      description = EXCLUDED.description,
      keycloak_role = EXCLUDED.keycloak_role,
      is_system_role = EXCLUDED.is_system_role;

-- ─── 4. Link each new role to its split groups via role_groups ──────────────

INSERT INTO role_groups (role_id, group_id)
SELECT r.id, pg_split.id
FROM permission_groups pg_orig
JOIN roles r
  ON r.tenant_id = pg_orig.tenant_id AND r.code = pg_orig.code
JOIN permission_groups pg_split
  ON pg_split.tenant_id = pg_orig.tenant_id
 AND pg_split.code LIKE pg_orig.code || '__%'
WHERE pg_orig.module = 'general'
ON CONFLICT DO NOTHING;

-- ─── 5. Single-module groups also get a 1:1 role ─────────────────────────────
-- Pre-existing groups that ALREADY had a real module (not 'general') still
-- need a role wrapper so employees assigned to them keep their permissions
-- after we drop employee_group_assignments below. Each gets a role with
-- the same code; the role contains exactly one group.

INSERT INTO roles (tenant_id, code, label, description, keycloak_role, is_system_role)
SELECT tenant_id, code, label, description, keycloak_role, is_system_role
FROM permission_groups pg
WHERE pg.module <> 'general'
  AND NOT EXISTS (SELECT 1 FROM roles r WHERE r.tenant_id = pg.tenant_id AND r.code = pg.code)
ON CONFLICT (tenant_id, code) DO NOTHING;

INSERT INTO role_groups (role_id, group_id)
SELECT r.id, pg.id
FROM permission_groups pg
JOIN roles r ON r.tenant_id = pg.tenant_id AND r.code = pg.code
WHERE pg.module <> 'general'
ON CONFLICT DO NOTHING;

-- ─── 6. Migrate employee assignments: groups → roles ─────────────────────────
-- Each existing employee_group_assignments row maps to a role of the same
-- code (1:1 because we created a role per group above, and 1:N for the
-- 'general' rows where the role contains multiple split groups).

INSERT INTO employee_role_assignments (employee_id, role_id, granted_by, granted_at)
SELECT
  ega.employee_id,
  r.id,
  ega.granted_by,
  ega.granted_at
FROM employee_group_assignments ega
JOIN permission_groups pg ON pg.id = ega.group_id
JOIN roles r ON r.tenant_id = pg.tenant_id AND r.code = pg.code
ON CONFLICT (employee_id, role_id) DO NOTHING;

-- ─── 7. Drop the old transitional rows + table + column ──────────────────────

-- Drop the 'general' parent rows (their split children + roles now exist).
DELETE FROM permission_groups WHERE module = 'general';

-- Drop the now-unused join table.
DROP TABLE IF EXISTS employee_group_assignments;

-- Drop keycloak_role from permission_groups (now lives on roles).
ALTER TABLE permission_groups DROP COLUMN IF EXISTS keycloak_role;

COMMIT;
```

**Idempotency notes**:
- Re-running on a clean post-migration DB: step 2 finds zero `module='general'` rows, inserts nothing. Step 3 same. Step 4 same. Step 5 finds existing 1:1 roles for every group, ON CONFLICT DO NOTHING skips. Step 6 finds an empty `employee_group_assignments` (already dropped) — wrap in `IF EXISTS` checks. Steps 7 are all `IF EXISTS` / `DROP COLUMN IF EXISTS`. Net result: zero changes.
- Wrap step 6 in:
  ```sql
  DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'employee_group_assignments') THEN
      INSERT INTO employee_role_assignments ...
    END IF;
  END $$;
  ```

**Module enum**: After step 7, `permission_groups.module` is constrained-by-data to actual modules (`cert`, `employee`, `compliance`, `tenant`). Add a soft check via a partial index on the catalog OR a CHECK constraint — leave it out of 42C scope for now (covered by acceptance test).

---

## Updated `db/queries/permissions.ts` (resolver chain)

The resolver now chains through three layers:

```typescript
export async function getPermissionsForEmployee(
  client: PoolClient,
  employeeId: string,
): Promise<string[]> {
  // Step 1: collect raw permissions chained employee → role → groups → permissions JSONB
  const r = await client.query<{ p: string }>(
    `SELECT DISTINCT jsonb_array_elements_text(pg.permissions) AS p
       FROM employee_role_assignments era
       JOIN role_groups rg            ON rg.role_id  = era.role_id
       JOIN permission_groups pg      ON pg.id       = rg.group_id
      WHERE era.employee_id = $1`,
    [employeeId],
  );
  const raw = r.rows.map(row => row.p);

  // Step 2: glob expansion (unchanged from 42A)
  const globs    = raw.filter(p => p.endsWith('*'));
  const literals = raw.filter(p => !p.endsWith('*'));
  if (globs.length === 0) return Array.from(new Set(literals)).sort();

  const catalog = await client.query<{ permission: string }>(
    `SELECT permission FROM permission_catalog`,
  );
  const allKnown = catalog.rows.map(c => c.permission);
  const expanded = new Set<string>(literals);
  for (const g of globs) {
    if (g === '*') {
      allKnown.forEach(p => expanded.add(p));
    } else {
      const prefix = g.slice(0, -1);
      allKnown.filter(p => p.startsWith(prefix)).forEach(p => expanded.add(p));
    }
  }
  return Array.from(expanded).sort();
}
```

The other 4 helpers RENAME and operate on roles directly:

| 42A name (now wrong) | 42C name | What it does |
|---|---|---|
| `grantRoleByCode` | `assignRoleToEmployee` | INSERT INTO employee_role_assignments |
| `revokeRoleByCode` | `removeRoleFromEmployee` | DELETE FROM employee_role_assignments |
| `getRoleCodesForEmployee` | (keep name; SQL changes) | SELECT r.code via the role layer |
| `countRolesForEmployee` | (keep name; SQL changes) | COUNT(*) FROM employee_role_assignments |

Move the role-specific helpers into a new `db/queries/roles.ts`. Permission-catalog helpers stay in `permissions.ts` (or move to `permission-catalog.ts` if cleaner).

---

## Drizzle schema update

```typescript
// packages/hr-service/src/db/schema.ts (excerpt)
export const roles = pgTable('roles', {
  id:            uuid('id').primaryKey().defaultRandom(),
  tenantId:      uuid('tenant_id').notNull(),
  code:          text('code').notNull(),
  label:         text('label').notNull(),
  description:   text('description'),
  keycloakRole:  text('keycloak_role').notNull(),     // moved here from permission_groups
  isSystemRole:  boolean('is_system_role').notNull().default(false),
  createdAt:     timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export const roleGroups = pgTable('role_groups', {
  roleId:  uuid('role_id').notNull().references(() => roles.id, { onDelete: 'cascade' }),
  groupId: uuid('group_id').notNull().references(() => permissionGroups.id, { onDelete: 'cascade' }),
}, ...);

export const employeeRoleAssignments = pgTable('employee_role_assignments', {
  employeeId: uuid('employee_id').notNull(),
  roleId:     uuid('role_id').notNull().references(() => roles.id, { onDelete: 'cascade' }),
  grantedBy:  uuid('granted_by'),
  grantedAt:  timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
}, ...);

// permissionGroups: drop keycloakRole column
// employeeGroupAssignments: drop entire export
```

---

## MCP tool updates

The three affected tools' MCP-level args don't change (they take a `role` parameter — which is now accurate). Internal implementation switches to roles helpers.

### `employee.grant-permission.tool.ts`

```typescript
// Internally calls assignRoleToEmployee(client, tenantId, employeeId, args.role, actor.id)
// instead of grantRoleByCode. Same arg name 'role', different table.
```

### `employee.revoke-permission.tool.ts`

```typescript
// Internally calls removeRoleFromEmployee. Same orphan-check via countRolesForEmployee
// (which now counts role assignments, not group assignments).
```

### `get-employee-permissions.tool.ts`

```typescript
// Calls getPermissionsForEmployee (chained resolver — already updated above).
// Calls getRoleCodesForEmployee for the role-codes list returned alongside.
// Output JSON shape unchanged: { permissions: string[], roles: string[] }
// (the bot consumes 'roles' as role codes — semantics now match).
```

---

## platform-core init-tenant-database.activity.ts update

After 42C, this activity seeds a different shape: per-module groups + roles + role_groups linkages. Five "system roles" become 1 role + N module-scoped groups + N role_groups rows each.

```typescript
const SYSTEM_DEFINITIONS = [
  {
    role: { code: 'hr_admin', label: 'HR Administrator', keycloak_role: 'hr' },
    groups: [
      { module: 'employee',   code: 'hr_admin__employee',   permissions: ['employee.create', 'employee.list', /* ... */] },
      { module: 'cert',       code: 'hr_admin__cert',       permissions: ['cert.approve', 'cert.list_all', /* ... */] },
      { module: 'compliance', code: 'hr_admin__compliance', permissions: ['compliance.view', /* ... */] },
    ],
  },
  // ... etc for the other 4 system roles
];

// For each definition: INSERT into permission_groups (the per-module groups),
// INSERT into roles (the role), INSERT into role_groups (linking them).
// All idempotent ON CONFLICT.
```

The activity now creates tenant-scoped roles + module groups for new tenants. The migration covers existing tenants; this activity covers future provisioning.

---

## Acceptance Criteria

- [ ] Migration `012_roles_layer.sql` applies cleanly. Post-migration:
  - `\d roles` exists with the expected shape including `keycloak_role`
  - `\d role_groups` exists
  - `\d employee_role_assignments` exists
  - `employee_group_assignments` no longer exists
  - `permission_groups` has no `keycloak_role` column
  - `SELECT count(*) FROM permission_groups WHERE module = 'general'` returns **0**
- [ ] Dev tenant existing data migrated:
  - `field_worker` originally had `permissions: ['cert.submit', 'cert.view_own', 'compliance.view_own']`. After migration: 2 permission_groups rows (`field_worker__cert`, `field_worker__compliance`) + 1 role `field_worker` linked to both via role_groups.
  - Same for `hr_standard`: 3 permission_groups rows (employee, cert, compliance modules) + 1 role.
- [ ] Existing employee assignments preserved:
  - Any employee who was in `employee_group_assignments` for `hr_standard` now has a row in `employee_role_assignments` for the `hr_standard` role.
  - `getPermissionsForEmployee` returns the same permission set as before for those employees.
- [ ] **Multi-role assignment is additive.** Test: assign one employee both `hr_standard` and `field_worker` → resolver returns the union of their permissions, deduped.
- [ ] Glob expansion still works post-chain. Test: a role containing a group with `permissions: ['cert.*']` resolves to all 4 cert permissions.
- [ ] All 5 query helpers in `db/queries/permissions.ts` (or split into `roles.ts`) operate on the new tables. `grep -rn "employee_group_assignments\b\|grantRoleByCode\b\|revokeRoleByCode\b" packages/` returns zero matches outside `db/migrations/`.
- [ ] MCP tools `employee.grant-permission`, `employee.revoke-permission`, `get-employee-permissions` work end-to-end. Their output shapes are unchanged.
- [ ] Re-running migration 012 on a fully-migrated DB is a no-op (zero rows changed, zero errors).
- [ ] platform-core's init-tenant-database.activity seeds the new shape (groups + role + role_groups) for a freshly-provisioned tenant.
- [ ] `pnpm -r run typecheck` passes.

---

## Out of Scope

- **Admin user bootstrap (PLATFORM_ADMIN_EMAIL)** — Slice 42B.
- **Realm role auto-assignment** when assigning a CIP role — Slice 42B (because admin bootstrap is the primary use case).
- **CHECK constraint on `permission_groups.module`** to enforce real-module enum (cert/employee/compliance/tenant). Rely on the catalog as soft enforcement; add CHECK in a future cleanup if it matters.
- **Removing `permission_groups.capabilities` legacy column** — defer to cleanup slice.
- **MCP tool rename** (`employee_grant_permission` → `employee_assign_role`). Tool args stay `role` parameter; internal helper now matches. The tool name itself stays for now (bot-side coordinated rename is its own concern).
- **Hierarchical role inheritance** (NIST RBAC1 — role A "is-a" role B). Not needed; composition via `role_groups` is enough.
- **Mutually-exclusive roles** (NIST RBAC2 — separation of duties). Not in current requirements.
- **Negative grants / deny rules.** Permissions union is positive-only.

---

## Cross-Slice Notes

- **CS-021 (RESOLVED)**: stays resolved. 42C's update to platform-core's init activity supersedes 42A's, with the role layer included.
- **CS-022 (OPEN)**: still open — cip_hr → cip_platform refactor unchanged.
- **42A's helper-rename deferral (`grantRoleByCode` etc.) is paid down here.** After 42C's rename, all helper names are accurate.

If migration 012 fails mid-way (e.g., Postgres aborts on a constraint violation in step 5), the BEGIN/COMMIT wrapper rolls back to pre-migration state. Rerun after fixing.

If the dev tenant's existing employees already had `field_worker` or `hr_standard` group assignments (likely), step 6 ports them. If not (fresh cluster), zero rows ported and the data is empty — that's fine.

---

## Commit

```
slice(42C): role layer (cross-module composition over permission groups)

Adds the `roles`, `role_groups`, `employee_role_assignments` tables
that sit on top of 42A's permission_groups. Roles are CIP business-
concept job functions (hr_manager, field_worker); they compose N
module-scoped groups via role_groups. Employees are assigned to
roles, not groups directly.

Migration 012:
  - Splits 42A's transitional 'general' multi-module groups into
    per-module groups (e.g. hr_standard → hr_standard__employee +
    hr_standard__cert + hr_standard__compliance)
  - Creates a role of the same code containing those split groups
  - Migrates each employee's group assignments to role assignments
    pointing to the role with the matching code
  - Drops employee_group_assignments (role layer is the only path)
  - Moves keycloak_role from permission_groups to roles where it
    semantically belongs

After 42C, no permission_groups row has module='general'. Every group
is single-module; cross-module bundling lives in roles. Multi-role
assignment is additive (employee with two roles = union of their
permissions, deduped, glob-expanded).

Helper renames complete: grantRoleByCode → assignRoleToEmployee,
etc. — names accurate now that they operate on roles.

Foundation for Slice 42B (admin user bootstrap), which assigns a
ROLE (hr-service-admin) plus the matching KC realm role (hr).
```
