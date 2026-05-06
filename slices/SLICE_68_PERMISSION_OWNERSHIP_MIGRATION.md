# Slice 68 — Permission ownership migration to `cip_platform`

> **Why this exists:** Phase 6 of Arc 1. Roles, permission groups, role-group bindings, role assignments, and the permission catalog still live in `cip_hr` even though they're platform-level concerns. Slice 67's `/auth/resolve` endpoint cross-schema-reads from `cip_hr.{employee_role_assignments, role_groups, permission_groups}`. Slice 68 moves these tables to `cip_platform` and renames `employee_role_assignments → user_role_assignments` (column `employee_id → user_id`, since employee.id == user.id 1:1 from slice 64).
>
> **After this slice:** platform-core owns identity AND authorization. hr-service contains only HR-specific data (employees with HR profile, certifications, etc.). The `/auth/resolve` query becomes single-schema. doc-service's permission seed writes to `cip_platform.permission_catalog`. hr-service's queries reference `cip_platform.*` via cross-schema (drizzle `pgSchema('cip_platform')` pattern from slice 65).
>
> **Hard cut.** Backfill, repoint, drop — all in one slice.

---

## Files in scope

```
# ── platform-core: backfill migration ───────────────────────────────────
packages/platform-core/src/db/migrations/007_backfill_permissions.sql     NEW (~80 LOC — INSERT INTO cip_platform.{roles,permission_groups,role_groups,user_role_assignments,permission_catalog} SELECT FROM cip_hr.* with column rename)

# ── platform-core: /auth/resolve simplified ─────────────────────────────
packages/platform-core/src/routes/auth.ts                                  MOD (drop cip_hr.* cross-schema; query cip_platform.* directly)

# ── hr-service: drizzle schema redefinition (cross-schema via pgSchema) ──
packages/hr-service/src/db/schema.ts                                       MOD (roles, permissionGroups, roleGroups → cipPlatform.table; rename employeeRoleAssignments → userRoleAssignments mapping cip_platform.user_role_assignments)

# ── hr-service: query layer rewrites ────────────────────────────────────
packages/hr-service/src/db/queries/roles.ts                                MOD (cip_platform.* prefix in raw SQL; column renames employee_id → user_id)
packages/hr-service/src/db/queries/permissions.ts                          MOD (cip_platform.* prefix; column renames)
packages/hr-service/src/db/queries/permission-catalog.ts                   MOD (cip_platform.* prefix)
packages/hr-service/src/services/permission-catalog-seed.ts                MOD (write to cip_platform.permission_catalog)

# ── hr-service: tool / activity call sites ──────────────────────────────
packages/hr-service/src/mcp-server/auth.ts                                 MOD (assertPermission still uses local helpers; no SQL change needed)
packages/hr-service/src/modules/admin/mcp-tools/group.list.tool.ts          MOD (drizzle queries auto-prefix; verify)
packages/hr-service/src/modules/admin/mcp-tools/permission-catalog.list.tool.ts  MOD
packages/hr-service/src/modules/admin/mcp-tools/permission.holders.tool.ts        MOD
packages/hr-service/src/modules/employees/mcp-tools/employee.grant-permission.tool.ts  MOD
packages/hr-service/src/modules/employees/activities/assign-default-role.activity.ts   MOD
packages/hr-service/src/modules/compliance/mcp-tools/get-compliance-summary.ts          MOD (likely just imports updated)

# ── hr-service: drop migration ──────────────────────────────────────────
packages/hr-service/src/db/migrations/050_drop_legacy_permission_tables.sql  NEW (~30 LOC — DROP TABLE cip_hr.{employee_role_assignments, role_groups, permission_groups, roles, permission_catalog} CASCADE; runs after backfill verified)
```

~700 LOC of net change (mostly mechanical SQL prefix + column rename). Pattern matches slice 65's consumer migration.

---

## Hard rules

1. **Hard cut.** All hr-service queries point at `cip_platform.*` after slice 68. No reads remain against `cip_hr.{roles,permission_groups,role_groups,employee_role_assignments,permission_catalog}`. Drop migration lands in the same slice (slice 65 left tenant tables as orphans for a release; slice 68 is more confident — backfill happens before the drop in the same atomic deploy).

2. **`employee_role_assignments → user_role_assignments`.** Column rename `employee_id → user_id`. The 1:1 mapping (employee.id == user.id) makes this a value-preserving rename. Drizzle table object renames `employeeRoleAssignments → userRoleAssignments` in hr-service schema.

3. **Drizzle cross-schema via `pgSchema('cip_platform')`.** Match the pattern established in slice 64-65 for `users`, `userIdentityLinks`, `tenantSettings`. Drizzle generates `cip_platform.*` SQL automatically.

4. **`/auth/resolve` simplifies.** No more cross-schema; single-schema query against `cip_platform.{roles, permission_groups, role_groups, user_role_assignments, permission_catalog}`. Faster query plan, cleaner code.

5. **Permission catalog seeding shifts to `cip_platform.permission_catalog`.** hr-service's startup seeder still runs (it owns the canonical list of HR's permissions); it just writes to platform-core's table now. Future slices (per chain) introduce per-service registration via HTTP API; slice 68 keeps the in-process seed pattern but cross-schema.

6. **Helm wait-init-container reused.** The slice 64 wait-init-container on hr-service polls `cip_platform.schema_migrations` for a list of migrations; extend that list to include `007_backfill_permissions.sql`. Belt-and-braces ordering.

7. **Pre-66 `onboarding_source='unknown'` employees keep their role assignments.** The backfill copies `employee_id → user_id` for every assignment, even legacy ones. No data loss.

---

## Backfill SQL — `cip_platform/007_backfill_permissions.sql`

```sql
-- Slice 68: move authorization tables from cip_hr to cip_platform.
-- One-time copy with column rename (employee_id → user_id).
-- Drop migration (cip_hr/050) follows in the same deploy.

BEGIN;

-- 1. roles
INSERT INTO cip_platform.roles
  (id, tenant_id, code, label, description, keycloak_role, is_system_role, created_at)
SELECT
  id, tenant_id, code, label, description, keycloak_role, is_system_role, created_at
FROM cip_hr.roles
ON CONFLICT (id) DO UPDATE SET
  code           = EXCLUDED.code,
  label          = EXCLUDED.label,
  description    = EXCLUDED.description,
  keycloak_role  = EXCLUDED.keycloak_role,
  is_system_role = EXCLUDED.is_system_role;

-- 2. permission_groups
INSERT INTO cip_platform.permission_groups
  (id, tenant_id, code, label, description, service, module, permissions, is_system, created_at)
SELECT
  id, tenant_id, code, label, description, service, module, permissions,
  -- cip_hr column is `is_system_role`; cip_platform column is `is_system`. Same data.
  COALESCE(is_system_role, false),
  created_at
FROM cip_hr.permission_groups
ON CONFLICT (id) DO UPDATE SET
  code        = EXCLUDED.code,
  label       = EXCLUDED.label,
  description = EXCLUDED.description,
  service     = EXCLUDED.service,
  module      = EXCLUDED.module,
  permissions = EXCLUDED.permissions,
  is_system   = EXCLUDED.is_system;

-- 3. role_groups (mapping table)
INSERT INTO cip_platform.role_groups (role_id, group_id)
SELECT role_id, group_id FROM cip_hr.role_groups
ON CONFLICT (role_id, group_id) DO NOTHING;

-- 4. employee_role_assignments → user_role_assignments
--    Column rename: employee_id → user_id. Since employee.id == user.id
--    (slice 64 1:1 mapping), the value carries over directly. tenant_id
--    derived from the role's tenant_id.
INSERT INTO cip_platform.user_role_assignments
  (user_id, role_id, tenant_id, granted_by, granted_at)
SELECT
  era.employee_id,
  era.role_id,
  r.tenant_id,
  era.granted_by,
  era.granted_at
FROM cip_hr.employee_role_assignments era
JOIN cip_hr.roles r ON r.id = era.role_id
ON CONFLICT (user_id, role_id) DO UPDATE SET
  tenant_id  = EXCLUDED.tenant_id,
  granted_by = EXCLUDED.granted_by,
  granted_at = EXCLUDED.granted_at;

-- 5. permission_catalog
INSERT INTO cip_platform.permission_catalog
  (service, module, permission, description)
SELECT service, module, permission, description
FROM cip_hr.permission_catalog
ON CONFLICT (service, module, permission) DO UPDATE SET
  description = EXCLUDED.description;

COMMIT;
```

---

## Drop migration — `cip_hr/050_drop_legacy_permission_tables.sql`

```sql
-- Slice 68: authorization tables moved to cip_platform. Drop the cip_hr
-- equivalents. Runs AFTER cip_platform/007_backfill_permissions.sql via
-- the wait-init-container pattern.

BEGIN;

DROP TABLE IF EXISTS employee_role_assignments CASCADE;
DROP TABLE IF EXISTS role_groups CASCADE;
DROP TABLE IF EXISTS permission_groups CASCADE;
DROP TABLE IF EXISTS roles CASCADE;
DROP TABLE IF EXISTS permission_catalog CASCADE;

COMMIT;
```

---

## hr-service drizzle redefinition

`packages/hr-service/src/db/schema.ts`:

```typescript
// Slice 68: roles + permission_groups + role_groups + user_role_assignments
// + permission_catalog moved to cip_platform. Drizzle generates cip_platform.*
// SQL automatically via pgSchema('cip_platform').

export const roles = cipPlatform.table('roles', {
  id:            uuid('id').primaryKey().defaultRandom(),
  tenantId:      uuid('tenant_id').notNull(),
  code:          text('code').notNull(),
  label:         text('label').notNull(),
  description:   text('description'),
  keycloakRole:  text('keycloak_role').notNull(),
  isSystemRole:  boolean('is_system_role').notNull().default(false),
  createdAt:     timestamp('created_at', { withTimezone: true }).defaultNow(),
})

export const permissionGroups = cipPlatform.table('permission_groups', {
  id:           uuid('id').primaryKey().defaultRandom(),
  tenantId:     uuid('tenant_id').notNull(),
  code:         text('code').notNull(),
  label:        text('label').notNull(),
  description:  text('description'),
  service:      text('service').notNull(),
  module:       text('module').notNull(),
  permissions:  jsonb('permissions').notNull().default([]),
  isSystem:     boolean('is_system').notNull().default(false),
  createdAt:    timestamp('created_at', { withTimezone: true }).defaultNow(),
})

export const roleGroups = cipPlatform.table('role_groups', {
  roleId:  uuid('role_id').notNull(),
  groupId: uuid('group_id').notNull(),
})

// Renamed from employeeRoleAssignments. Column rename: employee_id → user_id.
export const userRoleAssignments = cipPlatform.table('user_role_assignments', {
  userId:    uuid('user_id').notNull(),
  roleId:    uuid('role_id').notNull(),
  tenantId:  uuid('tenant_id').notNull(),
  grantedBy: uuid('granted_by'),
  grantedAt: timestamp('granted_at', { withTimezone: true }).defaultNow(),
})

export const permissionCatalog = cipPlatform.table('permission_catalog', {
  service:     text('service').notNull(),
  module:      text('module').notNull(),
  permission:  text('permission').notNull(),
  description: text('description'),
})
```

The variable name `employeeRoleAssignments` is renamed to `userRoleAssignments` everywhere. Mechanical sed-able rename.

---

## Acceptance criteria

1. **`pnpm -r run typecheck` clean** after all changes.
2. **`pnpm --filter @cip/platform-core migrate`** applies `007_backfill_permissions.sql`. Row counts match `cip_hr.*` for each table.
3. **`pnpm --filter @cip/hr-service migrate`** applies `050_drop_legacy_permission_tables.sql`. Tables gone from cip_hr.
4. **`/auth/resolve` returns same permissions** for the same user before and after the migration. No regression.
5. **`grep -rn 'cip_hr\.\(roles\|permission_groups\|role_groups\|employee_role_assignments\|permission_catalog\)' packages/`** returns zero application-code matches.
6. **hr-service permission catalog seeder writes to cip_platform.permission_catalog** at startup.
7. **No regressions in hr-service test suite.**

---

## Implementation status

**Implemented in commit-pending state on 2026-05-06.** Files touched:

**platform-core (new):**
- `packages/platform-core/src/db/migrations/007_backfill_permissions.sql` — copies roles, permission_groups (`is_system_role` → `is_system`), role_groups, employee_role_assignments → user_role_assignments (`employee_id` → `user_id`), permission_catalog from cip_hr to cip_platform with ON CONFLICT DO UPDATE

**platform-core (modified):**
- `packages/platform-core/src/routes/auth.ts` — `/auth/resolve` permission + role queries simplified to single-schema cip_platform.* (no more cip_hr cross-schema joins)

**hr-service (new):**
- `packages/hr-service/src/db/migrations/050_drop_legacy_permission_tables.sql` — `DROP TABLE cip_hr.{employee_role_assignments, role_groups, permission_groups, roles, permission_catalog}` CASCADE

**hr-service (modified):**
- `packages/hr-service/src/db/schema.ts` — `roles`, `permissionGroups` (with `isSystem` instead of `isSystemRole`), `roleGroups`, `userRoleAssignments` (renamed from `employeeRoleAssignments`; `userId` not `employeeId`), `permissionCatalog` all redefined as `cipPlatform.table('...')`. Cross-schema FK `references()` calls dropped per slice 62 hard rule 2.
- `packages/hr-service/src/db/queries/roles.ts` — every query rewritten with explicit `cip_platform.*` prefix; `assignRoleToEmployee` now writes `user_id` + `tenant_id`; `listEmployeesForRole` and `listEmployeesWithPermission` JOIN through `cip_platform.users` for email/fullName (cross-schema)
- `packages/hr-service/src/db/queries/permissions.ts` — `getPermissionsForEmployee`, `getRoleCodesForEmployee`, `countRolesForEmployee` rewritten with `cip_platform.user_role_assignments.user_id`
- `packages/hr-service/src/db/queries/permission-catalog.ts` — `cip_platform.permission_catalog` prefix in both helpers
- `packages/hr-service/src/services/permission-catalog-seed.ts` — INSERT now targets `cip_platform.permission_catalog`
- `packages/hr-service/src/modules/employees/activities/assign-default-role.activity.ts` — drizzle import renamed to `userRoleAssignments`; column rename `employeeId` → `userId`, `tenantId` added
- `packages/hr-service/helm/templates/deployment.yaml` — wait-init-container `REQUIRED` list extended with `007_backfill_permissions.sql`

**Verification:**
- ✅ `pnpm -r run typecheck` clean (all 7 packages)
- ✅ `pnpm -r run build` clean
- ⏳ DB-level: requires running `pnpm --filter @cip/platform-core migrate` (007) then `pnpm --filter @cip/hr-service migrate` (050) against a backfilled dev DB. Wait-init-container in prod handles ordering automatically.

## Locked decisions

1. **Drizzle cross-schema** via `pgSchema('cip_platform')` — match slice 65 pattern.
2. **Variable rename** `employeeRoleAssignments → userRoleAssignments` everywhere in hr-service.
3. **Hard cut**: backfill + drop in same slice. Wait-init-container ensures backfill ran before drop.
4. **Permission catalog seed** writes to `cip_platform.permission_catalog` (cross-schema from hr-service's pool).
5. **`/auth/resolve` simplified** to single-schema query in this slice.
6. **Drop migration runs in hr-service's migrate**, gated on the cip_platform/007 having landed (extend the wait-init list).

Slice is locked. Proceeding to implementation.
