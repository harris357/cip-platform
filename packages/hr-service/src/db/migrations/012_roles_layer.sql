-- Slice 42C: introduce the role layer on top of 42A's permission_groups.
-- Adds three tables (roles, role_groups, employee_role_assignments),
-- splits 'general' multi-module groups into per-module groups + a
-- composing role each, migrates employee assignments groups → roles,
-- drops employee_group_assignments and permission_groups.keycloak_role.
--
-- Wrapped in BEGIN/COMMIT so any failure rolls back to pre-migration.

BEGIN;

-- ─── 1. Create new tables ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS roles (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL,
  code           TEXT NOT NULL,
  label          TEXT NOT NULL,
  description    TEXT,
  keycloak_role  TEXT NOT NULL,                 -- 'hr' or 'employee' — implies which realm role
  is_system_role BOOLEAN NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
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

-- ─── 2. Split 'general' multi-module groups into per-module groups ───────────
-- For each 'general' row, group its permissions by module prefix and INSERT
-- one new permission_groups row per module. Code suffix is '__<module>'.

INSERT INTO permission_groups (
  tenant_id, service, module, code, keycloak_role, label, permissions, is_system_role
)
SELECT
  pg.tenant_id,
  pg.service,
  split_part(p, '.', 1)                                         AS module,
  pg.code || '__' || split_part(p, '.', 1)                      AS code,
  pg.keycloak_role,
  pg.label || ' (' || split_part(p, '.', 1) || ' module)'       AS label,
  jsonb_agg(p)                                                  AS permissions,
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
  SET label          = EXCLUDED.label,
      description    = EXCLUDED.description,
      keycloak_role  = EXCLUDED.keycloak_role,
      is_system_role = EXCLUDED.is_system_role;

-- ─── 4. Link each new role to its split groups via role_groups ──────────────

INSERT INTO role_groups (role_id, group_id)
SELECT r.id, pg_split.id
FROM permission_groups pg_orig
JOIN roles r
  ON r.tenant_id = pg_orig.tenant_id AND r.code = pg_orig.code
JOIN permission_groups pg_split
  ON pg_split.tenant_id = pg_orig.tenant_id
 AND pg_split.code      LIKE pg_orig.code || '__%'
 AND pg_split.module    <> 'general'
WHERE pg_orig.module = 'general'
ON CONFLICT DO NOTHING;

-- ─── 5. Existing single-module groups ALSO need a 1:1 role wrapper ───────────
-- Their employee assignments will be ported in step 6 to the role wrapper.

INSERT INTO roles (tenant_id, code, label, description, keycloak_role, is_system_role)
SELECT pg.tenant_id, pg.code, pg.label, pg.description, pg.keycloak_role, pg.is_system_role
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
-- Each existing employee_group_assignments row becomes an
-- employee_role_assignments row pointing to the role with the matching code.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
              WHERE table_name = 'employee_group_assignments') THEN
    INSERT INTO employee_role_assignments (employee_id, role_id, granted_by, granted_at)
    SELECT
      ega.employee_id,
      r.id,
      ega.granted_by,
      ega.granted_at
    FROM employee_group_assignments ega
    JOIN permission_groups pg ON pg.id = ega.group_id
    JOIN roles r              ON r.tenant_id = pg.tenant_id AND r.code = pg.code
    ON CONFLICT (employee_id, role_id) DO NOTHING;
  END IF;
END $$;

-- ─── 7. Drop the now-unused 'general' parent rows + table + column ───────────

DELETE FROM permission_groups WHERE module = 'general';

DROP TABLE IF EXISTS employee_group_assignments;

ALTER TABLE permission_groups DROP COLUMN IF EXISTS keycloak_role;

COMMIT;
