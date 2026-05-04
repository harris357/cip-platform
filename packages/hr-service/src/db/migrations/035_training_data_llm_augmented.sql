-- Slice 56M: LLM-augmented training data from user documentation.
--
-- Adds 'llm_augmented' to the source enum + an is_synthetic flag + doc
-- provenance columns so we can:
--   - exclude synthetic rows from holdout evaluation (eval gate stays
--     honest — we measure on real-world phrasings, not the LLM's biases)
--   - re-run augmentation when docs change without losing track of which
--     rows came from which doc / version
--   - audit synthetic vs human-curated proportions per intent
--
-- See SLICE_56M_LLM_AUGMENTATION.md for the full pipeline (chunk →
-- LLM-label → embed-dedup → LLM-judge → insert).

BEGIN;

ALTER TABLE bot_intent_training_data
  DROP CONSTRAINT IF EXISTS bot_intent_training_data_source_check;
ALTER TABLE bot_intent_training_data
  ADD CONSTRAINT bot_intent_training_data_source_check
    CHECK (source IN ('teach', 'turn_label', 'manual_csv', 'trace_export',
                      'verdict_positive', 'confusion_correction',
                      'llm_augmented'));

ALTER TABLE bot_intent_training_data
  ADD COLUMN IF NOT EXISTS is_synthetic        BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS source_doc          TEXT,
  ADD COLUMN IF NOT EXISTS source_doc_version  TEXT;

-- Index for "exclude synthetic from eval holdout" queries.
CREATE INDEX IF NOT EXISTS idx_bot_intent_training_data_synthetic
  ON bot_intent_training_data (is_synthetic, reviewed)
  WHERE is_synthetic = true;

-- Index for doc-grouped queries (re-augmentation diff against an old doc version).
CREATE INDEX IF NOT EXISTS idx_bot_intent_training_data_source_doc
  ON bot_intent_training_data (source_doc, source_doc_version)
  WHERE source_doc IS NOT NULL;

COMMIT;
