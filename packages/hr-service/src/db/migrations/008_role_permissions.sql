-- Slice 38: module-level permissions catalog.
--
-- The roles table from Slice 05A had `capabilities` JSONB and `keycloak_role`
-- (no `code`). This migration adds:
--   - `code` TEXT — short stable role identifier (e.g. 'field_worker',
--     'hr_standard'). Multiple roles per realm role: `code` is the natural key.
--   - `permissions` JSONB — array of permission codes (e.g. ["cert.submit"]).
--     Replaces the older `capabilities` JSONB object pattern. `capabilities`
--     stays for now to avoid breaking the existing get_employee_capabilities
--     tool until that tool is removed in this slice.
--
-- Migration is idempotent and forward-compatible:
--   1. ADD column code (nullable first, backfilled from keycloak_role,
--      then NOT NULL).
--   2. Drop the legacy UNIQUE(tenant_id, keycloak_role) so multiple roles
--      can share a realm role (cert_approver and cert_submitter both
--      keycloak_role='hr', different code values).
--   3. Add UNIQUE(tenant_id, code).
--   4. ADD column permissions (JSONB array, defaults to []).
--   5. Seed two dev-tenant roles aligning with Slice 32's hr/employee
--      realm roles. Production tenants get their own seed via a future
--      provisioning workflow.

ALTER TABLE roles
  ADD COLUMN IF NOT EXISTS code TEXT;

UPDATE roles SET code = keycloak_role WHERE code IS NULL;

ALTER TABLE roles
  ALTER COLUMN code SET NOT NULL;

-- Drop the legacy unique constraint by name; the auto-generated name pattern
-- from Postgres for (tenant_id, keycloak_role) UNIQUE is roles_tenant_id_keycloak_role_key.
ALTER TABLE roles DROP CONSTRAINT IF EXISTS roles_tenant_id_keycloak_role_key;

ALTER TABLE roles
  ADD CONSTRAINT roles_tenant_id_code_key UNIQUE (tenant_id, code);

ALTER TABLE roles
  ADD COLUMN IF NOT EXISTS permissions JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Dev-tenant role seed. Aligned with Slice 32's two realm roles (hr / employee).
-- field_worker → users with realm role 'employee'
-- hr_standard  → users with realm role 'hr' (additive, also have 'employee')
INSERT INTO roles (tenant_id, code, label, keycloak_role, permissions, is_system_role)
VALUES
  ('00000000-0000-0000-0000-000000000001',
   'field_worker', 'Field Worker', 'employee',
   '["cert.submit","cert.view_own","compliance.view_own"]'::jsonb, true),
  ('00000000-0000-0000-0000-000000000001',
   'hr_standard',  'HR Standard',  'hr',
   '["employee.create","employee.list","employee.find",
     "employee.assign_role","employee.revoke_role",
     "employee.migrate_identity","employee.disable",
     "employee.grant_permission","employee.revoke_permission",
     "cert.approve","cert.list_all","compliance.view"]'::jsonb, true)
ON CONFLICT (tenant_id, code) DO UPDATE
  SET permissions = EXCLUDED.permissions,
      label       = EXCLUDED.label,
      keycloak_role = EXCLUDED.keycloak_role;
