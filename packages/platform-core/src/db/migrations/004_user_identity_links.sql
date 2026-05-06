-- Slice 64: generic identity linking. Replaces the (currently denormalized)
-- users.keycloak_id and users.aad_oid columns with a flexible 1..N model
-- supporting any identity provider (keycloak, aad, google, saml, local_password,
-- and future additions like okta, github, custom OIDC, etc.).
--
-- For slice 64, users.keycloak_id and users.aad_oid stay as denormalized cache
-- columns (sync-employee keeps both in sync). Slice 65+ may drop them once
-- consumers shift to reading from this table.
--
-- Application enforces "user must have ≥1 identity link" at the sync-employee
-- write path. No DB-level CHECK in slice 64; consider adding a trigger in 65+
-- if defense-in-depth is needed.

BEGIN;

CREATE TABLE IF NOT EXISTS cip_platform.user_identity_links (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES cip_platform.users(id) ON DELETE CASCADE,
  tenant_id   UUID NOT NULL,                    -- denormalized for RLS
  provider    TEXT NOT NULL,                    -- 'keycloak'|'aad'|'google'|'saml'|'local_password'|...
  subject     TEXT NOT NULL,                    -- provider-specific external identity id
  metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, provider),                   -- one link per (user, provider)
  UNIQUE (tenant_id, provider, subject)         -- one external subject per provider per tenant
);
CREATE INDEX IF NOT EXISTS idx_uil_provider_subject
  ON cip_platform.user_identity_links(provider, subject);
CREATE INDEX IF NOT EXISTS idx_uil_user_id
  ON cip_platform.user_identity_links(user_id);

ALTER TABLE cip_platform.user_identity_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON cip_platform.user_identity_links
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID);

-- Backfill from users.keycloak_id (one link per user with non-null kc id)
INSERT INTO cip_platform.user_identity_links (user_id, tenant_id, provider, subject)
SELECT id, tenant_id, 'keycloak', keycloak_id
FROM cip_platform.users
WHERE keycloak_id IS NOT NULL
ON CONFLICT (user_id, provider) DO NOTHING;

-- Backfill from users.aad_oid
INSERT INTO cip_platform.user_identity_links (user_id, tenant_id, provider, subject)
SELECT id, tenant_id, 'aad', aad_oid
FROM cip_platform.users
WHERE aad_oid IS NOT NULL
ON CONFLICT (user_id, provider) DO NOTHING;

COMMIT;
