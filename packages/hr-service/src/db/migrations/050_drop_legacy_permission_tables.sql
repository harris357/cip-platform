-- Slice 68: authorization tables moved to cip_platform. Drop the cip_hr
-- equivalents. Runs AFTER cip_platform/007_backfill_permissions.sql via
-- the wait-init-container (extended to wait for slice-68 migration too).

BEGIN;

DROP TABLE IF EXISTS employee_role_assignments CASCADE;
DROP TABLE IF EXISTS role_groups CASCADE;
DROP TABLE IF EXISTS permission_groups CASCADE;
DROP TABLE IF EXISTS roles CASCADE;
DROP TABLE IF EXISTS permission_catalog CASCADE;

COMMIT;
