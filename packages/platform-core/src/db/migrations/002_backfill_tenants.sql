-- Slice 63: backfill cip_platform.* from cip_hr.*. One-time copy.
-- Subsequent writes go directly to cip_platform.*; the cip_hr equivalents
-- are NOT dropped here (slice 63b cleans them up after a successful deploy).
--
-- ON CONFLICT DO UPDATE SET — source (cip_hr) wins on every column except
-- created_at, which preserves the original timestamp. Catches divergence
-- if anyone manually inserted into cip_platform.* between slices 62 and 63.

BEGIN;

-- 1. Tenants
INSERT INTO cip_platform.tenants
  (id, display_name, status, tier, admin_email, realm,
   created_at, updated_at, suspended_at, deleted_at)
SELECT
  id, display_name, status, tier, admin_email, realm,
  created_at, updated_at, suspended_at, deleted_at
FROM public.tenants
ON CONFLICT (id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  status       = EXCLUDED.status,
  tier         = EXCLUDED.tier,
  admin_email  = EXCLUDED.admin_email,
  realm        = EXCLUDED.realm,
  updated_at   = EXCLUDED.updated_at,
  suspended_at = EXCLUDED.suspended_at,
  deleted_at   = EXCLUDED.deleted_at;
  -- created_at intentionally not updated — preserve original.

-- 2. Identity providers
INSERT INTO cip_platform.tenant_identity_providers
  (id, tenant_id, provider_type, alias, enabled, config, secret_ref,
   created_at, updated_at)
SELECT
  id, tenant_id, provider_type, alias, enabled, config, secret_ref,
  created_at, updated_at
FROM public.tenant_identity_providers
ON CONFLICT (id) DO UPDATE SET
  tenant_id     = EXCLUDED.tenant_id,
  provider_type = EXCLUDED.provider_type,
  alias         = EXCLUDED.alias,
  enabled       = EXCLUDED.enabled,
  config        = EXCLUDED.config,
  secret_ref    = EXCLUDED.secret_ref,
  updated_at    = EXCLUDED.updated_at;

-- 3. Tenant settings
INSERT INTO cip_platform.tenant_settings
  (id, tenant_id, litellm_virtual_key, channel_config, routing_overrides, updated_at)
SELECT
  id, tenant_id, litellm_virtual_key, channel_config,
  COALESCE(routing_overrides, '{}'::jsonb),
  updated_at
FROM public.tenant_settings
ON CONFLICT (id) DO UPDATE SET
  tenant_id           = EXCLUDED.tenant_id,
  litellm_virtual_key = EXCLUDED.litellm_virtual_key,
  channel_config      = EXCLUDED.channel_config,
  routing_overrides   = EXCLUDED.routing_overrides,
  updated_at          = EXCLUDED.updated_at;

-- 4. Routing rules (global)
INSERT INTO cip_platform.routing_rules
  (service, purpose, alias, notes, updated_at, updated_by)
SELECT
  service, purpose, alias, notes, updated_at, updated_by
FROM public.routing_rules
ON CONFLICT (service, purpose) DO UPDATE SET
  alias      = EXCLUDED.alias,
  notes      = EXCLUDED.notes,
  updated_at = EXCLUDED.updated_at,
  updated_by = EXCLUDED.updated_by;

COMMIT;
