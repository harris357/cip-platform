-- Slice 64: link employees to users in cip_platform.
-- user_id is a UUID column, not a Postgres FK (per slice 62 hard rule 2 —
-- no cross-schema constraints). Application code (sync-employee) enforces
-- referential integrity by writing user → links → employee in one tx.
--
-- This migration MUST run AFTER cip_platform/003_backfill_users.sql AND
-- cip_platform/004_user_identity_links.sql have completed. The hr-service
-- deployment's wait-init-container polls cip_platform.schema_migrations
-- for both before letting this migrate run (slice 64 helm change).

BEGIN;

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS user_id UUID;

-- Backfill from cip_platform.users using the 1:1 id mapping established by
-- cip_platform/003_backfill_users.sql (employee.id was reused as user.id).
UPDATE employees e
   SET user_id = u.id
  FROM cip_platform.users u
 WHERE e.id = u.id
   AND e.user_id IS NULL;

-- Defensive: if any employee row has no matching user, fail loudly here
-- rather than letting the NOT NULL ALTER do it cryptically. The
-- wait-init-container should have prevented this; this is belt-and-braces.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM employees WHERE user_id IS NULL) THEN
    RAISE EXCEPTION 'employees.user_id has NULL values after backfill — cip_platform.users incomplete? Confirm cip_platform/003_backfill_users.sql ran first.';
  END IF;
END $$;

ALTER TABLE employees
  ALTER COLUMN user_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_employees_user_id ON employees(user_id);

COMMIT;
