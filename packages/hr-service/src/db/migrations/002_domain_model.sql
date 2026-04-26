-- ─────────────────────────────────────────────────────────────────────────────
-- CIP HR Domain — Tenant Settings
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Tenant Settings ──────────────────────────────────────────────────────────
-- Stores per-tenant configuration issued during TenantProvisioningWorkflow.
-- litellm_virtual_key is written once at provision time, read on every LLM call.
CREATE TABLE tenant_settings (
  tenant_id           UUID PRIMARY KEY,
  litellm_virtual_key TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE tenant_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_settings_tenant_isolation ON tenant_settings
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
