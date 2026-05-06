-- Slice 68: move authorization tables from cip_hr to cip_platform.
-- One-time copy with column rename (employee_id → user_id; 1:1 mapping
-- established by slice 64). Drop migration (cip_hr/050) follows in the
-- same deploy via the slice 64 wait-init-container pattern.

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
--    cip_hr column is `is_system_role`; cip_platform column is `is_system`.
--    Same data, renamed.
INSERT INTO cip_platform.permission_groups
  (id, tenant_id, code, label, description, service, module, permissions, is_system, created_at)
SELECT
  id, tenant_id, code, label, description, service, module, permissions,
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
--    is sourced from the role's tenant_id.
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
