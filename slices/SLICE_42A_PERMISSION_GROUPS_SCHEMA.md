# Slice 42A — Permission Groups (rename + module scoping + catalog + globs)

> **Prerequisite:** Slice 38 (permissions baseline) complete.
> **Package:** `@cip/hr-service`, `@cip/shared`, `@cip/platform-core`
> **Verify:** `pnpm -r run typecheck && bash scripts/bootstrap.sh` (then SQL spot-check)

---

## Why This Slice Exists

Slice 38 introduced the `roles` table as a tenant-scoped bundle of permissions, plus the `employee_roles` join. Functionally fine, but three problems for the long term:

1. **Naming collision.** "Role" already means a Keycloak realm role (`hr`, `employee`). The DB `roles` table is a *different concept* — a tenant-scoped permission bundle. Conversations and code reviews routinely confuse the two. The right word for the DB concept is **permission group**.

2. **Module dimension is implicit.** Permission codes today are `<resource>.<action>` — `cert.submit`, `employee.create`, `compliance.view`. The `<resource>` prefix IS the module, but no schema column exposes it. You can't ask "what groups grant cert-module access?" without string-prefix scanning the JSONB.

3. **No globs.** Want a "cert admin" group that grants every current AND future cert permission? Today you have to enumerate them. Adding a new permission means hand-updating every admin group. AWS IAM solves this with `Action: ["cert:*"]` — same pattern fits CIP.

Slice 42A is foundation: rename the table, add `service` + `module` columns, build a permission catalog, teach the resolver to expand globs. **No behaviour change for existing users** — every group keeps the same permissions; the admin-bootstrap flow waits for Slice 42B.

---

## What You Are Building

```
packages/hr-service/src/
  db/
    migrations/
      010_permission_groups_rename.sql        ← NEW: roles → permission_groups + service + module
      011_permission_catalog.sql              ← NEW: catalog table
    queries/
      permissions.ts                          ← MOD: expand-globs in getPermissionsForEmployee
                                                  + rename helpers role* → group*
      permission-catalog.ts                   ← NEW: list/lookup helpers
    schema.ts                                 ← MOD: roles → permissionGroups, new columns
  services/
    permission-catalog-seed.ts                ← NEW: invoked at hr-service startup; populates
                                                  catalog from the static list of known codes
  modules/employees/mcp-tools/
    employee.grant-permission.tool.ts         ← MOD: grantRoleByCode → assignGroupByCode (internal)
    employee.revoke-permission.tool.ts        ← MOD: revokeRoleByCode → removeGroupByCode (internal)
    get-employee-permissions.tool.ts          ← MOD: queries against permission_groups
  index.ts                                    ← MOD: invoke catalog seed at startup

packages/platform-core/src/
  activities/
    init-tenant-database.activity.ts          ← MOD: seed permission_groups (rename of roles)
                                                  with service + module set

@cip/shared/src/types/                        ← (no changes — service-internal concept)
```

---

## Read Before Writing

- `packages/hr-service/src/db/migrations/008_role_permissions.sql` (current schema being renamed)
- `packages/hr-service/src/db/queries/permissions.ts` (5 helpers, all touched)
- `packages/hr-service/src/db/schema.ts` (Drizzle definition for `roles` and `employeeRoles`)
- `packages/hr-service/src/modules/employees/mcp-tools/employee.grant-permission.tool.ts`
- `packages/hr-service/src/modules/employees/mcp-tools/employee.revoke-permission.tool.ts`
- `packages/hr-service/src/modules/employees/mcp-tools/get-employee-permissions.tool.ts`
- `packages/platform-core/src/activities/init-tenant-database.activity.ts` (CS-021 fix; needs another rename pass)
- `slices/CROSS_SLICE_NOTES.md` (CS-021 stays open for the cip_hr → cip_platform refactor; this slice doesn't address it)

Do **not** modify any KC-realm-role code (`employee.assign-role.tool.ts`, `employee.revoke-role.tool.ts`). Those operate on Keycloak realm roles, a *different* concept this slice doesn't touch.

---

## Hard Rules (Seven Non-Negotiables)

1. **Search ALL code for "role" before declaring done.** The rename is invasive and prone to silent misses. Use `grep -rn "\brole\b\|\bRole\b" packages/` and audit every match: keep KC-realm-role mentions; rename DB-permission-group mentions. CI typecheck doesn't catch missed renames in strings (e.g., a stale `"role"` table name in a raw SQL query → runtime error). Follow up with `grep` for `\broles\b\|employee_roles\|grantRole\|revokeRole\|getRoleCodes\|countRoles` to be exhaustive.
2. **`tenantId` flows through every group resolution.** Per-tenant groups stay tenant-scoped. Globs expand against the *tenant's* permission catalog (in case future tenants disable specific permissions).
3. **Glob syntax is explicit and minimal.** Three forms only: literal (`cert.submit`), prefix-glob (`cert.*`), all-glob (`*`). No regex, no `**`, no negation. Anything fancier is YAGNI for a permission grant.
4. **Catalog is seeded from a code-resident list at startup.** No hand-edits in production DB; if you want a new permission, add it to the constants list in `permission-catalog-seed.ts` (or auto-derived from MCP tool annotations) and ship a deploy. Catalog table is read-by-resolver, written-by-startup.
5. **Migration is idempotent.** ALTER ... IF NOT EXISTS, RENAME ... IF EXISTS, ON CONFLICT for inserts. Re-running 010 on an already-renamed schema is a no-op.
6. **No `employee_permissions` direct-grant table** — Q6 in the design discussion settled this. Groups are the only assignment mechanism. If a one-off arises, it gets a one-off "ad-hoc" group. Keeps the data model simple.
7. **No behaviour change visible to users.** Same permissions, same gates, same MCP tools. Pure refactor + new infrastructure for Slice 42B to consume.

---

## Migration: `010_permission_groups_rename.sql`

```sql
-- Slice 42A: rename `roles` to `permission_groups` (clearer terminology;
-- "role" collides with Keycloak realm roles). Add explicit `service` and
-- `module` columns to formalize the namespace dimension that's been
-- implicit in permission code prefixes.

-- Idempotency: each step is safe to re-run.

-- 1. Rename the table.
ALTER TABLE IF EXISTS roles RENAME TO permission_groups;

-- 2. Rename the join table.
ALTER TABLE IF EXISTS employee_roles RENAME TO employee_group_assignments;

-- 3. Rename the FK column on the join table.
ALTER TABLE permission_groups
  RENAME CONSTRAINT roles_pkey TO permission_groups_pkey;
ALTER TABLE permission_groups
  RENAME CONSTRAINT roles_tenant_id_code_key TO permission_groups_tenant_id_code_key;
ALTER TABLE employee_group_assignments
  RENAME COLUMN role_id TO group_id;

-- 4. Add `service` (which CIP service this group belongs to). Default
--    'hr-service' for backfill — every existing group is in hr-service today.
ALTER TABLE permission_groups
  ADD COLUMN IF NOT EXISTS service TEXT NOT NULL DEFAULT 'hr-service';

-- 5. Add `module` (the resource namespace within the service). Backfill from
--    the existing permission code prefixes. A group whose permissions span
--    multiple modules (e.g., hr_standard) gets the placeholder 'general'.
ALTER TABLE permission_groups
  ADD COLUMN IF NOT EXISTS module TEXT NOT NULL DEFAULT 'general';

-- Backfill module from existing permissions JSONB.
-- Detect mono-module groups: all permissions share a prefix → module = that prefix.
-- Multi-module → 'general'.
UPDATE permission_groups
SET module = sub.module
FROM (
  SELECT id,
         CASE
           WHEN COUNT(DISTINCT split_part(p, '.', 1)) = 1
           THEN max(split_part(p, '.', 1))
           ELSE 'general'
         END AS module
  FROM permission_groups, jsonb_array_elements_text(permissions) AS p
  GROUP BY id
) sub
WHERE permission_groups.id = sub.id;

-- 6. Drop the old default once backfill is done; force callers to set explicitly.
ALTER TABLE permission_groups
  ALTER COLUMN service DROP DEFAULT,
  ALTER COLUMN module  DROP DEFAULT;

-- 7. Update unique key to include service + module (allow same `code` in
--    different modules: e.g., 'admin' for both cert and employee modules).
ALTER TABLE permission_groups
  DROP CONSTRAINT IF EXISTS permission_groups_tenant_id_code_key,
  ADD CONSTRAINT permission_groups_tenant_service_module_code_key
    UNIQUE (tenant_id, service, module, code);
```

Operationally: re-running 010 against an already-renamed DB hits the `IF EXISTS` / `IF NOT EXISTS` guards on every step — no error, no change.

---

## Migration: `011_permission_catalog.sql`

```sql
-- Slice 42A: registry of every known permission code. Resolver reads this
-- to expand glob entries (cert.* → all cert permissions). Operators read
-- it to audit "what permissions does this platform define".
--
-- Source of truth: hr-service's startup seed (services/permission-catalog-seed.ts).
-- DB is read-by-runtime, written-by-startup.

CREATE TABLE IF NOT EXISTS permission_catalog (
  service     TEXT NOT NULL,                -- 'hr-service'
  module      TEXT NOT NULL,                -- 'cert' | 'employee' | 'compliance' | 'tenant' | 'general'
  permission  TEXT NOT NULL,                -- 'cert.submit'
  description TEXT,
  PRIMARY KEY (service, module, permission)
);

-- Lightweight index for the prefix scans the resolver does.
CREATE INDEX IF NOT EXISTS permission_catalog_module_idx
  ON permission_catalog (service, module);
```

---

## `services/permission-catalog-seed.ts` (NEW)

Invoked once at hr-service startup. Idempotent ON CONFLICT.

```typescript
import type { Pool } from 'pg';

interface CatalogEntry {
  service:     'hr-service';
  module:      'cert' | 'employee' | 'compliance' | 'tenant' | 'general';
  permission:  string;
  description: string;
}

// The complete hr-service permission catalog. New permissions land here
// alongside the MCP tool that consumes them. Keep alphabetised by permission.
const HR_SERVICE_CATALOG: CatalogEntry[] = [
  // cert module
  { service: 'hr-service', module: 'cert',       permission: 'cert.approve',    description: 'Approve a HITL cert review' },
  { service: 'hr-service', module: 'cert',       permission: 'cert.list_all',   description: 'List certs across all employees' },
  { service: 'hr-service', module: 'cert',       permission: 'cert.submit',     description: 'Submit a new cert for processing' },
  { service: 'hr-service', module: 'cert',       permission: 'cert.view_own',   description: 'View own certs' },

  // compliance module
  { service: 'hr-service', module: 'compliance', permission: 'compliance.view',      description: 'View tenant-wide compliance reports' },
  { service: 'hr-service', module: 'compliance', permission: 'compliance.view_own',  description: 'View personal compliance status' },

  // employee module
  { service: 'hr-service', module: 'employee',   permission: 'employee.assign_role',       description: 'Assign Keycloak realm role' },
  { service: 'hr-service', module: 'employee',   permission: 'employee.create',            description: 'Provision a new employee' },
  { service: 'hr-service', module: 'employee',   permission: 'employee.disable',           description: 'Disable an employee' },
  { service: 'hr-service', module: 'employee',   permission: 'employee.find',              description: 'Lookup employee by email' },
  { service: 'hr-service', module: 'employee',   permission: 'employee.grant_permission',  description: 'Grant a permission group' },
  { service: 'hr-service', module: 'employee',   permission: 'employee.list',              description: 'List employees in tenant' },
  { service: 'hr-service', module: 'employee',   permission: 'employee.migrate_identity',  description: 'Switch identity type' },
  { service: 'hr-service', module: 'employee',   permission: 'employee.revoke_permission', description: 'Remove a permission group' },
  { service: 'hr-service', module: 'employee',   permission: 'employee.revoke_role',       description: 'Revoke Keycloak realm role' },

  // tenant module — currently no MCP tools require these, reserved for future
  { service: 'hr-service', module: 'tenant',     permission: 'tenant.channel_config.view', description: 'Read tenant channel config' },
];

export async function seedPermissionCatalog(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    for (const e of HR_SERVICE_CATALOG) {
      await client.query(
        `INSERT INTO permission_catalog (service, module, permission, description)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (service, module, permission) DO UPDATE
           SET description = EXCLUDED.description`,
        [e.service, e.module, e.permission, e.description],
      );
    }
    console.log(`[catalog] seeded ${HR_SERVICE_CATALOG.length} permissions`);
  } finally {
    client.release();
  }
}
```

Wire it into `packages/hr-service/src/index.ts` startup right after the pool is initialized.

---

## `db/queries/permissions.ts` — glob expansion

The current `getPermissionsForEmployee` query directly returns each row's permission strings. New version expands globs against the catalog before returning:

```typescript
export async function getPermissionsForEmployee(
  client: PoolClient,
  employeeId: string,
): Promise<string[]> {
  // Step 1: collect raw permissions from group assignments. Includes literals
  // ('cert.submit'), prefix-globs ('cert.*'), and the all-glob ('*').
  const r = await client.query<{ p: string }>(
    `SELECT DISTINCT jsonb_array_elements_text(pg.permissions) AS p
       FROM employee_group_assignments ega
       JOIN permission_groups pg ON pg.id = ega.group_id
      WHERE ega.employee_id = $1`,
    [employeeId],
  );
  const raw = r.rows.map(row => row.p);

  // Step 2: expand globs against permission_catalog.
  const globs    = raw.filter(p => p.endsWith('*'));
  const literals = raw.filter(p => !p.endsWith('*'));
  if (globs.length === 0) return literals.sort();

  const catalog = await client.query<{ permission: string }>(
    `SELECT permission FROM permission_catalog`,
  );
  const allKnown = catalog.rows.map(c => c.permission);
  const expanded = new Set<string>(literals);
  for (const g of globs) {
    if (g === '*') {
      // All-glob: every known permission, regardless of module.
      allKnown.forEach(p => expanded.add(p));
    } else {
      // Prefix-glob: 'cert.*' matches anything starting with 'cert.'
      const prefix = g.slice(0, -1); // 'cert.*' → 'cert.'
      allKnown
        .filter(p => p.startsWith(prefix))
        .forEach(p => expanded.add(p));
    }
  }
  return Array.from(expanded).sort();
}
```

Other query helpers rename mechanically:

| Old | New |
|---|---|
| `grantRoleByCode(client, tenantId, employeeId, roleCode, grantedBy)` | `assignGroupByCode(client, tenantId, employeeId, groupCode, grantedBy)` |
| `revokeRoleByCode(client, tenantId, employeeId, roleCode)` | `removeGroupByCode(client, tenantId, employeeId, groupCode)` |
| `getRoleCodesForEmployee(client, employeeId)` | `getGroupCodesForEmployee(client, employeeId)` |
| `countRolesForEmployee(client, employeeId)` | `countGroupsForEmployee(client, employeeId)` |

Inner SQL: `roles` → `permission_groups`, `role_id` → `group_id`, `employee_roles` → `employee_group_assignments`.

`assignGroupByCode` SQL adds the (service, module) match — but for backwards compat with existing callers, accept just `groupCode` and assume `service='hr-service'` (the only service that has groups today). When platform-core grows MCP tools, that assumption gets revisited.

---

## Drizzle schema update

```typescript
// packages/hr-service/src/db/schema.ts (excerpt)
export const permissionGroups = pgTable('permission_groups', {
  id:           uuid('id').primaryKey().defaultRandom(),
  tenantId:     uuid('tenant_id').notNull(),
  service:      text('service').notNull(),
  module:       text('module').notNull(),
  code:         text('code').notNull(),
  keycloakRole: text('keycloak_role').notNull(),       // unchanged: KC realm role this group activates
  label:        text('label').notNull(),
  description:  text('description'),
  capabilities: jsonb('capabilities').notNull().default({}),    // legacy, kept
  permissions:  jsonb('permissions').notNull().default([]),
  isSystemRole: boolean('is_system_role').notNull().default(false),
  createdAt:    timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export const employeeGroupAssignments = pgTable('employee_group_assignments', {
  employeeId: uuid('employee_id').notNull(),
  groupId:    uuid('group_id').notNull(),
  grantedBy:  uuid('granted_by'),
  grantedAt:  timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
}, ...);

export const permissionCatalog = pgTable('permission_catalog', {
  service:     text('service').notNull(),
  module:      text('module').notNull(),
  permission:  text('permission').notNull(),
  description: text('description'),
}, ...);
```

Drop `roles` and `employeeRoles` exports. Any consumer is in this slice's call-site list and gets renamed.

---

## platform-core init-tenant-database.activity.ts update

CS-021 (already RESOLVED) updated this to seed `roles` with `code` + `permissions`. Slice 42A renames the table; this activity needs a corresponding update. Three changes:

1. Table name: `roles` → `permission_groups`
2. Insert statement adds `service` and `module` columns
3. The five system role definitions get `service: 'hr-service'` and a chosen `module` per definition

```typescript
const SYSTEM_GROUPS = [
  {
    code: 'hr_admin',
    service: 'hr-service',
    module: 'general',                // multi-module → 'general'
    keycloak_role: 'hr',
    label: 'HR Administrator',
    permissions: ['employee.*', 'cert.*', 'compliance.*'],   // Slice 42A enables globs!
  },
  {
    code: 'field_operations',
    service: 'hr-service',
    module: 'general',
    keycloak_role: 'hr',
    label: 'Field Operations',
    permissions: ['employee.list', 'employee.find', 'cert.approve', 'cert.list_all', 'cert.submit', 'cert.view_own'],
  },
  {
    code: 'field_employee',
    service: 'hr-service',
    module: 'cert',
    keycloak_role: 'employee',
    label: 'Field Employee',
    permissions: ['cert.submit', 'cert.view_own', 'compliance.view_own'],
  },
  {
    code: 'compliance_manager',
    service: 'hr-service',
    module: 'compliance',
    keycloak_role: 'hr',
    label: 'Compliance Manager',
    permissions: ['compliance.view', 'cert.list_all'],
  },
  {
    code: 'site_manager',
    service: 'hr-service',
    module: 'employee',
    keycloak_role: 'hr',
    label: 'Site Manager',
    permissions: ['employee.list', 'cert.list_all'],
  },
];
```

Plus the INSERT statement matches: `INSERT INTO permission_groups (tenant_id, service, module, code, keycloak_role, label, permissions, is_system_role) ...`

---

## Migration 008's dev-tenant seed needs an update too

Migration 008 (Slice 38) seeded `field_worker` and `hr_standard` roles for the dev tenant. After 010 runs, those rows still exist in the renamed `permission_groups` table — they just need their `service` + `module` backfilled (the migration's UPDATE block handles that).

Should we also update those rows to use globs? E.g., `hr_standard` permissions array could become `['employee.*', 'cert.*', 'compliance.view']` instead of enumerating every `employee.*` permission. **Don't do it in 42A** — Hard Rule #7 (no behaviour change). Operator can edit later, OR Slice 42B's admin-bootstrap path adds a new "service-admin" group that uses globs instead of touching existing groups.

---

## Acceptance Criteria

- [ ] Migration `010_permission_groups_rename.sql` applies cleanly. After running:
  - `\d permission_groups` shows `service`, `module` columns
  - `\d employee_group_assignments` shows `group_id` (renamed from `role_id`)
  - The unique key is `(tenant_id, service, module, code)`
  - All previous rows have non-null service ('hr-service') and module (backfilled from permission prefix)
- [ ] Migration `011_permission_catalog.sql` applies. `SELECT count(*) FROM permission_catalog;` returns 0 (catalog seeded by hr-service at startup, not migration).
- [ ] hr-service startup seeds the catalog. After pod restart: `SELECT module, count(*) FROM permission_catalog GROUP BY module;` shows the expected breakdown (cert: 4, compliance: 2, employee: 9, tenant: 1).
- [ ] `getPermissionsForEmployee` expands globs. Add a test row: a permission_group with `permissions: '["cert.*"]'`, assign to a test employee, call the resolver, assert it returns `cert.approve`, `cert.list_all`, `cert.submit`, `cert.view_own`.
- [ ] `getPermissionsForEmployee` expands `*`. Same test, group with `'["*"]'` → returns every permission in the catalog.
- [ ] All four legacy queries (`grant`/`revoke`/`getCodes`/`count`) renamed to `*Group*`. Old names removed, no shims.
- [ ] Existing call sites (3 MCP tools + 1 platform-core activity) updated to new names + new schema.
- [ ] **`grep -rn "\bemployee_roles\b\|\bgrantRoleByCode\b\|\brevokeRoleByCode\b\|\bcountRolesForEmployee\b\|\bgetRoleCodesForEmployee\b" packages/` returns ZERO matches** (the leftover-rename guard).
- [ ] **`grep -rn "\bfrom roles\b\|\binto roles\b\|\bupdate roles\b" packages/` returns zero matches** (catches stale raw SQL).
- [ ] Re-running migration 010 on an already-migrated DB is a no-op (zero changes, zero errors).
- [ ] `pnpm -r run typecheck` passes.
- [ ] All Slice 38/CS-021 functionality preserved: `get_employee_permissions` returns the same set of permission strings for the dev tenant's existing user (assuming no glob groups assigned).
- [ ] Cross-slice note CS-022 unchanged (still OPEN; this slice doesn't address the cip_hr → cip_platform refactor).

---

## Out of Scope

- **Admin user creation + bootstrap elevation** — Slice 42B.
- **Removing the `keycloak_role` column** from permission_groups. Still useful: it documents which KC realm role this group "implies." Keep.
- **Removing the legacy `capabilities` column.** Still kept for back-compat per Slice 38; can be dropped in a future cleanup slice once we're sure no consumer reads it.
- **Renaming MCP tools** (`employee_grant_permission` → `employee_assign_group`). Internal helper names rename here; the user-facing MCP tool names stay so the bot doesn't have to relearn them. Defer the user-facing rename to a coordinated bot-and-hr-service slice.
- **Module enum constraints** (e.g., a CHECK constraint that `module ∈ {'cert', 'employee', ...}`). Soft enum via the catalog table is enough for now.
- **Per-permission descriptions** beyond the catalog seed text. The catalog has a `description` column; can be enriched later.
- **Glob-of-globs / patterns more complex than `prefix.*` and `*`**. Keep glob syntax minimal.

---

## Cross-Slice Notes

- **CS-021 (RESOLVED)**: stays resolved — this slice updates the platform-core activity to use the new schema, but doesn't reopen the cip_hr → cip_platform debt.
- **No new cross-slice notes anticipated.** This is an intra-service refactor.

If migration 010's UPDATE backfill fails on a multi-module group's permissions (e.g., `hr_standard` has both `employee.*` and `cert.*`), the case branch evaluates to `'general'`. That's the intended behaviour, but worth verifying after running.

---

## Commit

```
slice(42A): permission_groups (rename roles + module scoping + catalog + globs)

Renames `roles` → `permission_groups` and `employee_roles` →
`employee_group_assignments`. Adds explicit `service` and `module`
columns to formalize the namespace dimension that's been implicit in
permission code prefixes (cert.*, employee.*, compliance.*).

New `permission_catalog` table seeded at hr-service startup from a
code-resident list (services/permission-catalog-seed.ts). Resolver
(getPermissionsForEmployee) now expands glob entries — `cert.*` to
all cert permissions, `*` to everything in the catalog. Operator
groups can use `permissions: ['cert.*']` instead of enumerating
every cert permission code.

Migration is idempotent. No behaviour change visible to users — same
permissions, same gates, same MCP tools. Foundation for Slice 42B
(admin-user bootstrap via PLATFORM_ADMIN_EMAIL).
```
