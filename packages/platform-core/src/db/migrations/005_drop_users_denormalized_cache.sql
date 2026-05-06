-- Slice 65: drop the denormalized keycloak_id and aad_oid columns from
-- cip_platform.users. Source of truth is cip_platform.user_identity_links.
-- All read sites now use the link table directly via the helper functions
-- (getKeycloakSubject, getAadOid, etc.).

BEGIN;

-- Drop the unique partial indexes that reference the columns
DROP INDEX IF EXISTS cip_platform.idx_users_tenant_keycloak_id;
DROP INDEX IF EXISTS cip_platform.idx_users_tenant_aad_oid;

ALTER TABLE cip_platform.users
  DROP COLUMN IF EXISTS keycloak_id,
  DROP COLUMN IF EXISTS aad_oid;

COMMIT;
