-- Slice 35 — canonical tenant ledger + per-tenant identity provider rows.
-- Platform-level tables: NOT tenant-scoped, NO RLS. These rows describe
-- the tenants themselves; everything else (employees, certifications, etc.)
-- references tenants.id.

CREATE TABLE IF NOT EXISTS tenants (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name  TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','suspended','deleted')),
  tier          TEXT NOT NULL DEFAULT 'standard'
                  CHECK (tier IN ('standard','enterprise','trial')),
  admin_email   TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  suspended_at  TIMESTAMPTZ,
  deleted_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_tenants_status ON tenants(status);

CREATE TABLE IF NOT EXISTS tenant_identity_providers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider_type   TEXT NOT NULL
                    CHECK (provider_type IN (
                      'aad_oidc','google_oidc','generic_oidc',
                      'saml','sms_otp','local_password'
                    )),
  alias           TEXT NOT NULL,
  enabled         BOOLEAN NOT NULL DEFAULT true,
  config          JSONB NOT NULL DEFAULT '{}'::jsonb,
  secret_ref      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, alias)
);
CREATE INDEX IF NOT EXISTS idx_tip_tenant_enabled
  ON tenant_identity_providers(tenant_id) WHERE enabled = true;

-- Reverse-lookup index used by the bot on every Teams message:
-- "given an Entra tenant GUID, which CIP tenant does it map to?"
CREATE INDEX IF NOT EXISTS idx_tip_aad_lookup
  ON tenant_identity_providers((config ->> 'aad_tenant_id'))
  WHERE provider_type = 'aad_oidc' AND enabled = true;
