-- Slice 64: backfill cip_platform.users from cip_hr.employees identity fields.
-- One-time copy. Subsequent inserts come from sync-employee on every bot turn.
-- After slice 65, cip_hr.employees has its identity columns dropped; this
-- backfill is the last time those columns are READ.
--
-- Reuses employee.id as user.id (1:1 mapping per locked decision D1). Slice 65's
-- read-site migrations become mechanical column rename via this 1:1.

BEGIN;

INSERT INTO cip_platform.users
  (id, tenant_id, email, full_name, given_name, surname,
   keycloak_id, aad_oid, identity_type,
   created_at, updated_at)
SELECT
  e.id,
  e.tenant_id,
  e.email,
  e.full_name,
  e.given_name,
  e.surname,
  e.keycloak_id,
  e.aad_oid,
  e.identity_type,
  COALESCE(e.created_at, NOW()),
  COALESCE(e.updated_at, NOW())
FROM cip_hr.employees e
ON CONFLICT (id) DO UPDATE SET
  tenant_id     = EXCLUDED.tenant_id,
  email         = EXCLUDED.email,
  full_name     = EXCLUDED.full_name,
  given_name    = EXCLUDED.given_name,
  surname       = EXCLUDED.surname,
  keycloak_id   = EXCLUDED.keycloak_id,
  aad_oid       = EXCLUDED.aad_oid,
  identity_type = EXCLUDED.identity_type,
  updated_at    = EXCLUDED.updated_at;
  -- created_at intentionally not updated.

COMMIT;
