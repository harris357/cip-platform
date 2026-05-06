-- Slice 62 — cip_platform schema foundation.
-- Empty tables for the auth/identity migration (Arc 1, Phase 0).
-- No data movement. No application reads from these yet.
-- Slice 63+ backfills from cip_hr.

CREATE SCHEMA IF NOT EXISTS cip_platform;

-- ============================================================
-- TENANTS (platform-level, NO RLS)
-- ============================================================

CREATE TABLE IF NOT EXISTS cip_platform.tenants (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name  TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','suspended','deleted')),
  tier          TEXT NOT NULL DEFAULT 'standard'
                  CHECK (tier IN ('standard','enterprise','trial')),
  admin_email   TEXT NOT NULL,
  realm         TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  suspended_at  TIMESTAMPTZ,
  deleted_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_tenants_status
  ON cip_platform.tenants(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_realm
  ON cip_platform.tenants(realm);

CREATE TABLE IF NOT EXISTS cip_platform.tenant_identity_providers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES cip_platform.tenants(id) ON DELETE CASCADE,
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
  ON cip_platform.tenant_identity_providers(tenant_id) WHERE enabled = true;
-- Reverse-lookup index used by the bot on every Teams message:
-- "given an Entra tenant GUID, which CIP tenant does it map to?"
CREATE INDEX IF NOT EXISTS idx_tip_aad_lookup
  ON cip_platform.tenant_identity_providers((config ->> 'aad_tenant_id'))
  WHERE provider_type = 'aad_oidc' AND enabled = true;

CREATE TABLE IF NOT EXISTS cip_platform.tenant_settings (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL UNIQUE REFERENCES cip_platform.tenants(id) ON DELETE CASCADE,
  litellm_virtual_key TEXT NOT NULL DEFAULT '',
  channel_config      JSONB NOT NULL DEFAULT '{}'::jsonb,
  routing_overrides   JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE cip_platform.tenant_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON cip_platform.tenant_settings
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID);

-- ============================================================
-- ROUTING (global, no RLS)
-- ============================================================

CREATE TABLE IF NOT EXISTS cip_platform.routing_rules (
  service     TEXT        NOT NULL,
  purpose     TEXT        NOT NULL,
  alias       TEXT        NOT NULL,
  notes       TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by  TEXT,
  PRIMARY KEY (service, purpose)
);

-- ============================================================
-- USERS (tenant-scoped, RLS)
-- Identity-only fields — HR profile (employment_type, phone, dob)
-- stays on cip_hr.employees (slice 64 will add user_id FK to it).
-- ============================================================

CREATE TABLE IF NOT EXISTS cip_platform.users (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL,
  email          TEXT NOT NULL,
  full_name      TEXT NOT NULL,
  given_name     TEXT,
  surname        TEXT,
  keycloak_id    TEXT,
  aad_oid        TEXT,
  identity_type  TEXT NOT NULL
                   CHECK (identity_type IN ('aad_federated','field_employee','local_password')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, email)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_tenant_keycloak_id
  ON cip_platform.users(tenant_id, keycloak_id) WHERE keycloak_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_tenant_aad_oid
  ON cip_platform.users(tenant_id, aad_oid) WHERE aad_oid IS NOT NULL;

ALTER TABLE cip_platform.users ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON cip_platform.users
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID);

-- ============================================================
-- PERMISSION GROUPS + ROLES + ASSIGNMENTS
-- Mirrors cip_hr's final post-42C shape:
--   permission_groups hold the actual permission codes (JSONB array).
--   roles compose permission_groups via role_groups.
--   user_role_assignments grants roles to users.
-- ============================================================

CREATE TABLE IF NOT EXISTS cip_platform.permission_groups (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL,
  code           TEXT NOT NULL,
  label          TEXT NOT NULL,
  description    TEXT,
  service        TEXT NOT NULL,
  module         TEXT NOT NULL,
  permissions    JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_system      BOOLEAN NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, service, module, code)
);

CREATE TABLE IF NOT EXISTS cip_platform.roles (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL,
  code           TEXT NOT NULL,
  label          TEXT NOT NULL,
  description    TEXT,
  keycloak_role  TEXT NOT NULL,
  is_system_role BOOLEAN NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, code)
);

CREATE TABLE IF NOT EXISTS cip_platform.role_groups (
  role_id  UUID NOT NULL REFERENCES cip_platform.roles(id)              ON DELETE CASCADE,
  group_id UUID NOT NULL REFERENCES cip_platform.permission_groups(id)  ON DELETE CASCADE,
  PRIMARY KEY (role_id, group_id)
);

CREATE TABLE IF NOT EXISTS cip_platform.user_role_assignments (
  user_id     UUID NOT NULL,
  role_id     UUID NOT NULL REFERENCES cip_platform.roles(id) ON DELETE CASCADE,
  tenant_id   UUID NOT NULL,
  granted_by  UUID,
  granted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, role_id)
);
CREATE INDEX IF NOT EXISTS user_role_assignments_role_idx
  ON cip_platform.user_role_assignments (role_id);
CREATE INDEX IF NOT EXISTS user_role_assignments_tenant_idx
  ON cip_platform.user_role_assignments (tenant_id);

ALTER TABLE cip_platform.user_role_assignments ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON cip_platform.user_role_assignments
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID);

-- ============================================================
-- PERMISSION CATALOG (global, no RLS)
-- Populated at runtime by each service registering its permissions
-- (Arc 1 slice 65). Empty here.
-- ============================================================

CREATE TABLE IF NOT EXISTS cip_platform.permission_catalog (
  service       TEXT NOT NULL,
  module        TEXT NOT NULL,
  permission    TEXT NOT NULL,
  description   TEXT,
  registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (service, module, permission)
);
CREATE INDEX IF NOT EXISTS permission_catalog_module_idx
  ON cip_platform.permission_catalog (service, module);
