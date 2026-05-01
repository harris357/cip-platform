# Slice 42A — Permission Groups (rename + module + catalog + globs)

> **Prerequisite:** Slice 38 (permissions baseline) complete.
> **Successor:** Slice 42C (role layer on top of groups). Slice 42B (admin bootstrap) depends on 42C.
> **Package:** `@cip/hr-service`, `@cip/shared`, `@cip/platform-core`
> **Verify:** `pnpm -r run typecheck && bash scripts/bootstrap.sh` (then SQL spot-check)

---

## The hierarchy this slice is building toward

```
Service       Keycloak realm role     'hr' / 'employee'           coarse access gate
   ↓
Role          CIP business concept     'hr_manager'                what HR assigns to a person   (Slice 42C)
   ↓
Group         module-scoped bundle     'cert_admin' (cert mod)     reusable building block       (this slice)
   ↓
Permission    atomic code              'cert.submit'               gates one tool                (this slice — catalog)
   ↓
Tool          MCP function             process_document            actual work
```

42A delivers the **Group + Permission** layers. 42C adds the **Role** layer on top. 42B uses everything to bootstrap the admin user.

---

## Why This Slice Exists

Slice 38's `roles` table has three issues that compound as the system scales:

1. **Naming collision.** "Role" already means a Keycloak realm role (`hr`, `employee`). The DB `roles` table is a *different concept* — a tenant-scoped permission bundle. The conversation routinely confuses the two. Right word for the DB concept is **permission group**.

2. **Module dimension is implicit.** Permission codes today are `<resource>.<action>` — `cert.submit`, `employee.create`. The `<resource>` prefix IS the module, but no schema column exposes it. You can't ask "what groups grant cert-module access?" without prefix-scanning JSONB.

3. **No globs.** Want a "cert admin" group that grants every current AND future cert permission? Today you have to enumerate. Adding a new permission means hand-updating every admin group. AWS IAM solves this with `Action: ["cert:*"]` — same fits CIP.

42A renames the table, adds `service` + `module` columns, builds a permission catalog, teaches the resolver to expand globs. **No behaviour change visible to users** — every existing group keeps the same permissions; user-facing MCP tools work the same.

42A is **deliberately small** — it doesn't introduce the role layer (that's 42C). The reason for the split: the schema rename + catalog + globs are 1 day of focused work. Adding the role composition layer in the same migration would double the blast radius. Ship 42A first, validate the catalog and glob expansion are working, then layer 42C on top.

---

## What 42A DOES

- Rename `roles` → `permission_groups`, `employee_roles` → `employee_group_assignments`
- Add `service` + `module` columns to `permission_groups`
- Add `permission_catalog` table, seeded at hr-service startup from a code-resident list
- Teach `getPermissionsForEmployee` to expand `cert.*` and `*` glob entries against the catalog
- Update affected query helpers (5 functions) to use new table/column names
- Update Drizzle schema, MCP tools, platform-core's tenant-init activity to match

## What 42A DOES NOT do (deferred to 42C)

- **No `roles` table** (the new business-concept role). Today, employees are still assigned directly to permission_groups, not roles. 42C introduces the role layer.
- **No splitting of multi-module groups.** Existing groups like `hr_standard` (which has `employee.*`, `cert.approve`, `compliance.view`) get `module = 'general'` as a transitional marker. 42C will split those into per-module groups + a role that composes them.
- **No move of `keycloak_role` column.** Stays on `permission_groups` for now. 42C moves it to the new `roles` table where it semantically belongs.
- **No employee-side helper renames** (`grantRoleByCode` etc.). Helpers keep their `*Role*` names from Slice 38 — they ARE technically wrong (now operating on permission_groups not roles) but renaming them in 42A only to rename them again in 42C is two churn passes. Keep stable names; 42C will repurpose them when the role layer is real.

---

## What You Are Building

```
packages/hr-service/src/
  db/
    migrations/
      010_permission_groups_rename.sql        ← NEW: roles → permission_groups + service + module
      011_permission_catalog.sql              ← NEW: catalog table
    queries/
      permissions.ts                          ← MOD: glob expansion in getPermissionsForEmployee
                                                  + table/column rename in 5 helpers
                                                  (helper FUNCTION names unchanged — 42C handles)
      permission-catalog.ts                   ← NEW: list/lookup helpers
    schema.ts                                 ← MOD: roles → permissionGroups (Drizzle), new columns
  services/
    permission-catalog-seed.ts                ← NEW: invoked at hr-service startup
  modules/employees/mcp-tools/
    employee.grant-permission.tool.ts         ← MOD: queries against permission_groups (no rename)
    employee.revoke-permission.tool.ts        ← MOD: queries against permission_groups
    get-employee-permissions.tool.ts          ← MOD: queries against permission_groups
  index.ts                                    ← MOD: invoke catalog seed at startup

packages/platform-core/src/
  activities/
    init-tenant-database.activity.ts          ← MOD: seed permission_groups (rename + service/module),
                                                  multi-module rows still use 'general'

slices/
  SLICE_42A_PERMISSION_GROUPS_SCHEMA.md       ← this doc
```

---

## Read Before Writing

- `packages/hr-service/src/db/migrations/008_role_permissions.sql` (current schema being renamed)
- `packages/hr-service/src/db/queries/permissions.ts` (5 helpers — keep names, swap inner SQL)
- `packages/hr-service/src/db/schema.ts` (Drizzle definition for `roles` and `employeeRoles`)
- `packages/hr-service/src/modules/employees/mcp-tools/employee.grant-permission.tool.ts`
- `packages/hr-service/src/modules/employees/mcp-tools/employee.revoke-permission.tool.ts`
- `packages/hr-service/src/modules/employees/mcp-tools/get-employee-permissions.tool.ts`
- `packages/platform-core/src/activities/init-tenant-database.activity.ts` (CS-021 fix; needs another rename pass)

Do **not** modify any KC-realm-role code (`employee.assign-role.tool.ts`, `employee.revoke-role.tool.ts`). Those operate on Keycloak realm roles — a *different* concept this slice doesn't touch.

---

## Hard Rules (Seven Non-Negotiables)

1. **Search ALL code for "role" before declaring done.** The rename touches raw SQL strings that typecheck won't catch. Run:
   ```
   grep -rn "\bemployee_roles\b\|\bfrom roles\b\|\binto roles\b\|\bupdate roles\b" packages/
   ```
   Should return zero matches outside legacy migrations.
2. **`tenantId` flows through every group resolution.** Per-tenant groups stay tenant-scoped. Globs expand against the *tenant's* permission catalog (in case future tenants disable specific permissions).
3. **Glob syntax is explicit and minimal.** Three forms: literal (`cert.submit`), prefix-glob (`cert.*`), all-glob (`*`). No regex, no `**`, no negation.
4. **Catalog is seeded from a code-resident list at startup.** No hand-edits in production DB. New permission → add to `permission-catalog-seed.ts` constants → ship a deploy. Catalog is read-by-resolver, written-by-startup.
5. **Migration is idempotent.** ALTER ... IF NOT EXISTS, RENAME ... IF EXISTS, ON CONFLICT for inserts. Re-running 010 on already-renamed schema = zero-change no-op.
6. **`module = 'general'` is a TRANSITIONAL marker, not a permanent value.** Multi-module groups (currently: `hr_standard`, `field_worker`, plus the 5 platform-core seeds) get `module='general'` after 42A's migration. 42C will split each into per-module groups + a role that composes them. After 42C, `module = 'general'` should be unreachable. **No new groups should be created with `module = 'general'`** during 42A's lifetime — operators creating groups must pick `cert`, `employee`, `compliance`, or `tenant`.
7. **No behaviour change visible to users.** Same permissions, same gates, same MCP tools. Pure refactor + new infrastructure for 42C/42B to consume.

---

## Migration: `010_permission_groups_rename.sql`

```sql
-- Slice 42A: rename `roles` → `permission_groups`, `employee_roles` →
-- `employee_group_assignments`. Add `service` + `module` columns.
-- "module" is the resource namespace within a service: 'cert', 'employee',
-- 'compliance', 'tenant', or transitional 'general' for multi-module rows
-- that 42C will split.
--
-- Idempotent: every step uses IF EXISTS / IF NOT EXISTS / DO UPDATE.

-- 1. Rename the tables.
ALTER TABLE IF EXISTS roles                 RENAME TO permission_groups;
ALTER TABLE IF EXISTS employee_roles        RENAME TO employee_group_assignments;

-- 2. Rename column and constraints.
ALTER TABLE permission_groups
  RENAME CONSTRAINT roles_pkey TO permission_groups_pkey;
ALTER TABLE permission_groups
  RENAME CONSTRAINT roles_tenant_id_code_key TO permission_groups_tenant_id_code_key;
ALTER TABLE employee_group_assignments
  RENAME COLUMN role_id TO group_id;

-- 3. Add `service` (default 'hr-service' — the only service today).
ALTER TABLE permission_groups
  ADD COLUMN IF NOT EXISTS service TEXT NOT NULL DEFAULT 'hr-service';

-- 4. Add `module`. Backfill from permission code prefixes:
--    - mono-module (all permissions share a prefix) → use that prefix
--    - multi-module (hr_standard, field_worker, hr_admin, ...) → 'general'
--      ⚠ Slice 42C splits these into per-module groups + a composing role.
ALTER TABLE permission_groups
  ADD COLUMN IF NOT EXISTS module TEXT NOT NULL DEFAULT 'general';

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

-- 5. Drop the temporary defaults — every new row must specify both.
ALTER TABLE permission_groups
  ALTER COLUMN service DROP DEFAULT,
  ALTER COLUMN module  DROP DEFAULT;

-- 6. New unique key includes service + module — different modules can
--    share a `code` (e.g., 'admin' in cert and employee modules both).
ALTER TABLE permission_groups
  DROP CONSTRAINT IF EXISTS permission_groups_tenant_id_code_key,
  ADD CONSTRAINT permission_groups_tenant_service_module_code_key
    UNIQUE (tenant_id, service, module, code);
```

---

## Migration: `011_permission_catalog.sql`

```sql
-- Slice 42A: registry of every known permission code.
-- Resolver expands glob entries (cert.* → all cert permissions) by
-- joining against this catalog. Operators read it for audit.
--
-- Source of truth: hr-service's startup seed (services/permission-catalog-seed.ts).
-- DB is read-by-runtime, written-by-startup. Idempotent ON CONFLICT.

CREATE TABLE IF NOT EXISTS permission_catalog (
  service     TEXT NOT NULL,                -- 'hr-service'
  module      TEXT NOT NULL,                -- 'cert' | 'employee' | 'compliance' | 'tenant'
  permission  TEXT NOT NULL,                -- 'cert.submit'
  description TEXT,
  PRIMARY KEY (service, module, permission)
);

CREATE INDEX IF NOT EXISTS permission_catalog_module_idx
  ON permission_catalog (service, module);
```

Note: `module` here is always one of the real modules (cert, employee, compliance, tenant). The catalog never has `module = 'general'` — that's only on transitional permission_groups rows.

---

## `services/permission-catalog-seed.ts` (NEW)

Invoked once at hr-service startup. Idempotent ON CONFLICT.

```typescript
import type { Pool } from 'pg';

interface CatalogEntry {
  service:     'hr-service';
  module:      'cert' | 'employee' | 'compliance' | 'tenant';
  permission:  string;
  description: string;
}

// The complete hr-service permission catalog. Add new permissions here
// alongside the MCP tool that consumes them. Alphabetised by permission.
const HR_SERVICE_CATALOG: CatalogEntry[] = [
  // cert module
  { service: 'hr-service', module: 'cert', permission: 'cert.approve',  description: 'Approve a HITL cert review' },
  { service: 'hr-service', module: 'cert', permission: 'cert.list_all', description: 'List certs across all employees' },
  { service: 'hr-service', module: 'cert', permission: 'cert.submit',   description: 'Submit a new cert for processing' },
  { service: 'hr-service', module: 'cert', permission: 'cert.view_own', description: 'View own certs' },

  // compliance module
  { service: 'hr-service', module: 'compliance', permission: 'compliance.view',     description: 'View tenant-wide compliance reports' },
  { service: 'hr-service', module: 'compliance', permission: 'compliance.view_own', description: 'View personal compliance status' },

  // employee module
  { service: 'hr-service', module: 'employee', permission: 'employee.assign_role',       description: 'Assign Keycloak realm role' },
  { service: 'hr-service', module: 'employee', permission: 'employee.create',            description: 'Provision a new employee' },
  { service: 'hr-service', module: 'employee', permission: 'employee.disable',           description: 'Disable an employee' },
  { service: 'hr-service', module: 'employee', permission: 'employee.find',              description: 'Lookup employee by email' },
  { service: 'hr-service', module: 'employee', permission: 'employee.grant_permission',  description: 'Grant a permission group / role' },
  { service: 'hr-service', module: 'employee', permission: 'employee.list',              description: 'List employees in tenant' },
  { service: 'hr-service', module: 'employee', permission: 'employee.migrate_identity',  description: 'Switch identity type' },
  { service: 'hr-service', module: 'employee', permission: 'employee.revoke_permission', description: 'Revoke a permission group / role' },
  { service: 'hr-service', module: 'employee', permission: 'employee.revoke_role',       description: 'Revoke Keycloak realm role' },

  // tenant module — reserved
  { service: 'hr-service', module: 'tenant', permission: 'tenant.channel_config.view', description: 'Read tenant channel config' },
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

Wire into `packages/hr-service/src/index.ts` startup right after the pool is initialized.

---

## `db/queries/permissions.ts` — glob expansion

The current `getPermissionsForEmployee` returns each row's permission strings directly. New version expands globs against the catalog.

```typescript
export async function getPermissionsForEmployee(
  client: PoolClient,
  employeeId: string,
): Promise<string[]> {
  // Step 1: collect raw permissions from group assignments. Includes
  // literals ('cert.submit'), prefix-globs ('cert.*'), and all-glob ('*').
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
      const prefix = g.slice(0, -1);   // 'cert.*' → 'cert.'
      allKnown.filter(p => p.startsWith(prefix)).forEach(p => expanded.add(p));
    }
  }
  return Array.from(expanded).sort();
}
```

The other 4 helpers (`grantRoleByCode`, `revokeRoleByCode`, `getRoleCodesForEmployee`, `countRolesForEmployee`) keep their function names and signatures — only inner SQL changes:

| Function | SQL change |
|---|---|
| `grantRoleByCode(client, tenantId, employeeId, roleCode, grantedBy)` | `INSERT INTO employee_group_assignments (employee_id, group_id, granted_by) SELECT $1, id, $4 FROM permission_groups WHERE tenant_id = $2 AND code = $3 ON CONFLICT DO NOTHING` |
| `revokeRoleByCode(client, tenantId, employeeId, roleCode)` | `DELETE FROM employee_group_assignments WHERE employee_id = $1 AND group_id IN (SELECT id FROM permission_groups WHERE tenant_id = $2 AND code = $3)` |
| `getRoleCodesForEmployee(client, employeeId)` | `SELECT pg.code FROM employee_group_assignments ega JOIN permission_groups pg ON pg.id = ega.group_id WHERE ega.employee_id = $1 ORDER BY pg.code` |
| `countRolesForEmployee(client, employeeId)` | `SELECT COUNT(*)::text AS n FROM employee_group_assignments WHERE employee_id = $1` |

The function names will become semantically-correct again after Slice 42C (when employees ARE assigned to roles and these helpers cascade through `role_groups`). Keep the names stable — same APIs, swappable implementations.

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
  keycloakRole: text('keycloak_role').notNull(),  // stays here in 42A; 42C moves to roles table
  label:        text('label').notNull(),
  description:  text('description'),
  capabilities: jsonb('capabilities').notNull().default({}),  // legacy, kept
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

Drop `roles` and `employeeRoles` exports.

---

## platform-core init-tenant-database.activity.ts update

CS-021 (RESOLVED) updated this to seed `roles` with `code` + `permissions`. 42A's rename means another small update:

1. Insert into `permission_groups` not `roles`
2. Specify `service: 'hr-service'` and `module: 'general'` for each multi-module seed (5 rows: hr_admin, field_operations, field_employee, compliance_manager, site_manager)
3. ON CONFLICT key changes to `(tenant_id, service, module, code)`

```typescript
const SYSTEM_GROUPS = [
  {
    code: 'hr_admin',
    service: 'hr-service',
    module: 'general',                // multi-module → transitional 'general'; 42C will split
    keycloak_role: 'hr',
    label: 'HR Administrator',
    permissions: ['employee.create', 'employee.list', /* ... */],
  },
  // ... etc
];
```

Slice 42C will rewrite this activity to seed per-module groups + a role that composes them. For 42A, just keep the existing 5-group shape with the right column names.

---

## Acceptance Criteria

- [ ] Migration `010_permission_groups_rename.sql` applies cleanly:
  - `\d permission_groups` shows `service`, `module` columns (NOT NULL)
  - `\d employee_group_assignments` shows `group_id` (renamed from `role_id`)
  - Unique key: `(tenant_id, service, module, code)`
  - All previous rows have non-null service ('hr-service') and module (backfilled correctly: monomodule groups got their prefix, multi-module got 'general')
- [ ] Migration `011_permission_catalog.sql` applies; table exists, empty.
- [ ] hr-service startup seeds the catalog. After pod restart: `SELECT module, count(*) FROM permission_catalog GROUP BY module ORDER BY module` returns `cert: 4, compliance: 2, employee: 9, tenant: 1`.
- [ ] **`getPermissionsForEmployee` expands globs.** Add a test row: `permission_groups` with `permissions: '["cert.*"]'`, assign to a test employee, call resolver, assert it returns `['cert.approve', 'cert.list_all', 'cert.submit', 'cert.view_own']`.
- [ ] `getPermissionsForEmployee` expands `*`. Same test, group with `'["*"]'` → returns every permission in the catalog.
- [ ] All 5 query helpers keep their `grantRoleByCode` etc. names. Inner SQL queries `permission_groups` not `roles`. (Names are temporarily inaccurate; 42C reconciles.)
- [ ] Existing call sites (3 MCP tools + 1 platform-core activity) updated to new schema (table + column names).
- [ ] **Cleanup grep guard:** `grep -rn "\bemployee_roles\b\|\bfrom roles\b\|\binto roles\b\|\bupdate roles\b" packages/` returns zero matches outside `db/migrations/`.
- [ ] Re-running migration 010 on an already-migrated DB is a no-op (zero changes, zero errors).
- [ ] `pnpm -r run typecheck` passes.
- [ ] All Slice 38/CS-021 functionality preserved: `get_employee_permissions` MCP tool returns the same permission set for the dev tenant's existing user.
- [ ] Cross-slice note CS-022 unchanged (still OPEN; 42A doesn't address cip_hr → cip_platform refactor).

---

## Out of Scope — explicitly deferred

- **Role layer (`roles`, `role_groups`, `employee_role_assignments` tables)** — Slice 42C.
- **Splitting multi-module groups** (hr_standard etc.) into per-module groups — Slice 42C.
- **Moving `keycloak_role` column** from permission_groups to roles — Slice 42C.
- **Renaming helpers** (`grantRoleByCode` → `assignRoleByCode` etc.) — done in Slice 42C when the names regain semantic accuracy.
- **Admin user bootstrap** (PLATFORM_ADMIN_EMAIL) — Slice 42B.
- **Eliminating the legacy `capabilities` column** from permission_groups. Still kept for back-compat per Slice 38; future cleanup slice.
- **Per-permission descriptions richer than catalog seed text.** Catalog has `description`; can be enriched later.
- **Glob-of-globs / patterns more complex than `prefix.*` and `*`** — keep glob syntax minimal.
- **Per-tenant permission catalog** (different tenants disabling specific permissions). Today the catalog is global. Easy to add via a `tenant_id` column later.

---

## Cross-Slice Notes

- **CS-021 (RESOLVED)**: stays resolved. 42A updates platform-core's init activity to use new schema.
- **CS-022 (OPEN)**: untouched. The cip_hr → cip_platform refactor is a separate concern.
- **No new cross-slice notes anticipated.** Pure intra-service refactor.

If 42A's UPDATE backfill of `module` fails for an unexpected case (a group with empty permissions JSONB?), the CASE expression returns `'general'`. That's acceptable — it's a multi-module-equivalent that 42C will handle.

---

## Commit

```
slice(42A): permission_groups rename + module column + catalog + globs

Renames `roles` → `permission_groups` and `employee_roles` →
`employee_group_assignments`. Adds explicit `service` + `module`
columns. Multi-module groups (hr_standard, field_worker, etc.) get
`module='general'` as a TRANSITIONAL marker — Slice 42C splits them
into per-module groups + a role composing them.

New `permission_catalog` table seeded at hr-service startup from
services/permission-catalog-seed.ts. Resolver
(getPermissionsForEmployee) now expands glob entries — `cert.*` to
all cert permissions, `*` to everything in the catalog.

Helper function names (grantRoleByCode etc.) intentionally
unchanged — 42C reconciles them when the role layer makes the
names semantically accurate again. Avoids two churn passes.

Migration is idempotent. No behaviour change visible to users.
Foundation for Slice 42C (role layer) and Slice 42B (admin user
bootstrap).
```
