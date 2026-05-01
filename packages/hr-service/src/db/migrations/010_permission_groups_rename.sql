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

-- 2. Rename the column on the join table.
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
  DROP CONSTRAINT IF EXISTS roles_tenant_id_code_key,
  DROP CONSTRAINT IF EXISTS permission_groups_tenant_id_code_key,
  ADD CONSTRAINT permission_groups_tenant_service_module_code_key
    UNIQUE (tenant_id, service, module, code);
