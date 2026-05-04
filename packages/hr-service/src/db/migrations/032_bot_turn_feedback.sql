-- Slice 56F: explicit user verdict on bot turns.
--
-- Until now, training-data import has relied on implicit signals
-- (clean-success heuristic in 56E). Per the slice 56-family review,
-- explicit user verdicts (👍 / 👎) and corrections ("should have called
-- X") are the highest-quality training signal we can collect.
--
-- The verdict columns live on bot_turn_metrics (not bot_intent_training_data)
-- because they describe THE TURN, not a labelled training row. The trace
-- importer (slice 56H) reads them to compute trust tiers when promoting
-- a turn to bot_intent_training_data.
--
-- See slices/SLICE_56_FAMILY_REVIEW.md for the full architecture.

BEGIN;

ALTER TABLE bot_turn_metrics
  ADD COLUMN IF NOT EXISTS user_verdict     TEXT,
  ADD COLUMN IF NOT EXISTS user_correction  TEXT,
  ADD COLUMN IF NOT EXISTS user_verdict_at  TIMESTAMPTZ;

ALTER TABLE bot_turn_metrics
  DROP CONSTRAINT IF EXISTS bot_turn_metrics_user_verdict_check;
ALTER TABLE bot_turn_metrics
  ADD CONSTRAINT bot_turn_metrics_user_verdict_check
    CHECK (user_verdict IS NULL OR user_verdict IN ('positive', 'negative'));

-- Slice 56F: extend bot_intent_training_data source enum so verdict-driven
-- import (56H) can land rows with the right provenance flag.
ALTER TABLE bot_intent_training_data
  DROP CONSTRAINT IF EXISTS bot_intent_training_data_source_check;
ALTER TABLE bot_intent_training_data
  ADD CONSTRAINT bot_intent_training_data_source_check
    CHECK (source IN ('teach', 'turn_label', 'manual_csv', 'trace_export',
                      'verdict_positive', 'confusion_correction'));

-- Index for the importer to find unprocessed verdicts quickly.
CREATE INDEX IF NOT EXISTS idx_bot_turn_metrics_user_verdict
  ON bot_turn_metrics (user_verdict, user_verdict_at DESC)
  WHERE user_verdict IS NOT NULL;

-- Tunable: kill switch for the verdict UI. Default true (we want the
-- feedback signal); operators can disable per-tenant if they don't want
-- the buttons in their channel.
INSERT INTO bot_tunables (tenant_id, key, value_json, notes) VALUES
  ('00000000-0000-0000-0000-000000000000', 'lg.verdict_ui_enabled', 'true',
   'Slice 56F: when true, every bot reply gets a footer card with 👍/👎/🔍 actions. False reverts to the plain markdown footer (no verdict buttons).')
ON CONFLICT (tenant_id, key) DO NOTHING;

COMMIT;
