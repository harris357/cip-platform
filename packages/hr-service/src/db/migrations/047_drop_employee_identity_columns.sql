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

-- New uniqueness: one employee row per user. upsertEmployee uses this
-- as the ON CONFLICT target.
ALTER TABLE employees
  ADD CONSTRAINT employees_user_id_unique UNIQUE (user_id);

COMMIT;
