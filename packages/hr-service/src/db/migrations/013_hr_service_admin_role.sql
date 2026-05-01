-- Slice 42B: per-tenant `hr-service-admin` role for the platform admin
-- bootstrap flow. Composed of four module-admin groups (cert, employee,
-- compliance, tenant), each with a single glob permission. Slice 42A's
-- resolver expands `cert.*` etc. against the catalog at lookup time, so
-- the admin role automatically inherits any new permission added later.
--
-- Idempotent ON CONFLICT DO UPDATE — re-runs converge.

BEGIN;

-- ─── 1. Per-module admin groups (4 per tenant) ───────────────────────────────

INSERT INTO permission_groups (
  tenant_id, service, module, code, label, permissions, is_system_role
)
SELECT
  t.id,
  'hr-service',
  m.module,
  'admin__' || m.module,
  upper(substring(m.module, 1, 1)) || substring(m.module, 2) || ' Module Admin',
  jsonb_build_array(m.module || '.*'),
  true
FROM tenants t
CROSS JOIN (VALUES ('cert'), ('employee'), ('compliance'), ('tenant')) AS m(module)
ON CONFLICT (tenant_id, service, module, code) DO UPDATE
  SET permissions    = EXCLUDED.permissions,
      label          = EXCLUDED.label,
      is_system_role = true;

-- ─── 2. The hr-service-admin role per tenant ────────────────────────────────

INSERT INTO roles (
  tenant_id, code, label, description, keycloak_role, is_system_role
)
SELECT
  id,
  'hr-service-admin',
  'HR Service Administrator',
  'Cross-module admin: every permission in hr-service. Implies KC realm role hr.',
  'hr',
  true
FROM tenants
ON CONFLICT (tenant_id, code) DO UPDATE
  SET label          = EXCLUDED.label,
      description    = EXCLUDED.description,
      keycloak_role  = EXCLUDED.keycloak_role,
      is_system_role = true;

-- ─── 3. Link the role to its 4 module-admin groups ──────────────────────────

INSERT INTO role_groups (role_id, group_id)
SELECT r.id, pg.id
FROM roles r
JOIN permission_groups pg
  ON pg.tenant_id = r.tenant_id
 AND pg.service   = 'hr-service'
 AND pg.code      LIKE 'admin\___%' ESCAPE '\'         -- 'admin__cert', 'admin__employee', etc.
WHERE r.code = 'hr-service-admin'
ON CONFLICT DO NOTHING;

COMMIT;
