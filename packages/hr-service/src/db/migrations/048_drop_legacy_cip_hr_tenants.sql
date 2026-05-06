-- Slice 63b cleanup, folded into slice 65. Drop the tenant tables that lived
-- in cip_hr until slice 63. cip_platform.* has been the source of truth since
-- slice 63; no application code reads from these.

BEGIN;

DROP TABLE IF EXISTS routing_rules CASCADE;
DROP TABLE IF EXISTS tenant_settings CASCADE;
DROP TABLE IF EXISTS tenant_identity_providers CASCADE;
DROP TABLE IF EXISTS tenants CASCADE;

COMMIT;
