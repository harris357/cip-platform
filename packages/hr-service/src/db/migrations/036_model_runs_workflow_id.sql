-- Slice 56N: cross-reference bot_intent_model_runs rows back to the
-- Temporal workflow that produced them. Lets ops correlate "which
-- workflow trained model v..." in Temporal Web UI vs "which model
-- shipped on date X" in the DB lineage.
--
-- The workflow_id is the Temporal workflow id, e.g.:
--   RetrainModel-platform-cron-20260518
--   RetrainModel-00000000-…-001-manual-abc123
-- Format: `RetrainModel-${tenantId ?? 'platform'}-${triggerId}`

BEGIN;

ALTER TABLE bot_intent_model_runs
  ADD COLUMN IF NOT EXISTS workflow_id TEXT;

CREATE INDEX IF NOT EXISTS idx_bot_intent_model_runs_workflow_id
  ON bot_intent_model_runs (workflow_id)
  WHERE workflow_id IS NOT NULL;

COMMIT;
