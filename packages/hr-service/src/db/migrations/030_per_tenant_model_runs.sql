-- Slice 56D: per-tenant intent-classifier models.
--
-- Adds tenant_id (nullable) to bot_intent_model_runs. NULL = the
-- platform-wide model (back-compat default); a UUID = a tenant-specific
-- model trained from that tenant's labelled rows only.
--
-- The original migration 029 declared `model_version TEXT NOT NULL UNIQUE`,
-- which assumes one global namespace. With per-tenant models we want
-- tenants to reuse short version names without collision (e.g. tenant A's
-- 'v20260504-1234' and tenant B's 'v20260504-1234' should coexist).
-- We replace the global UNIQUE with two partial unique indexes:
--   - per-tenant rows must be unique within (tenant_id, model_version)
--   - platform rows (tenant_id IS NULL) must still be globally unique on
--     model_version alone
--
-- Forward-only. Existing rows have tenant_id = NULL (platform-wide), so
-- the back-compat unique constraint on model_version still holds for
-- those rows via the partial index.

BEGIN;

-- 1. Add the column.
ALTER TABLE bot_intent_model_runs
  ADD COLUMN IF NOT EXISTS tenant_id UUID;

-- 2. Drop the table-wide UNIQUE on model_version. It was created
--    implicitly by the column constraint in 029.
ALTER TABLE bot_intent_model_runs
  DROP CONSTRAINT IF EXISTS bot_intent_model_runs_model_version_key;

-- 3. Recreate uniqueness as two partial indexes.
CREATE UNIQUE INDEX IF NOT EXISTS bot_intent_model_runs_tenant_version_uidx
  ON bot_intent_model_runs (tenant_id, model_version)
  WHERE tenant_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS bot_intent_model_runs_global_version_uidx
  ON bot_intent_model_runs (model_version)
  WHERE tenant_id IS NULL;

-- 4. Lookup index: latest run per tenant.
CREATE INDEX IF NOT EXISTS idx_bot_intent_model_runs_tenant_trained_at
  ON bot_intent_model_runs (tenant_id, trained_at DESC);

COMMIT;
