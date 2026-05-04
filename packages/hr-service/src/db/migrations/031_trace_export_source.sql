-- Slice 56E: extend bot_intent_training_data for Langfuse trace import.
--
-- 1. Add 'trace_export' to the source CHECK constraint. Slice 56B already
--    teaches the TS type about it; this catches the DB up.
-- 2. Add source_langfuse_trace_id — the Langfuse UUID, separate from
--    source_turn_id (bot's 8-char hex turnId). One row populated by
--    import_traces.py carries both: the bot's turnId in source_turn_id
--    (links to bot_turn_metrics) and the Langfuse trace_id in
--    source_langfuse_trace_id (deep-links to the Langfuse UI).

BEGIN;

-- Drop + recreate the constraint. The original lived in 025; rename
-- not relevant since we DROPped + ADDed the constraint by name.
ALTER TABLE bot_intent_training_data
  DROP CONSTRAINT IF EXISTS bot_intent_examples_source_check;
ALTER TABLE bot_intent_training_data
  DROP CONSTRAINT IF EXISTS bot_intent_training_data_source_check;
ALTER TABLE bot_intent_training_data
  ADD CONSTRAINT bot_intent_training_data_source_check
    CHECK (source IN ('teach', 'turn_label', 'manual_csv', 'trace_export'));

ALTER TABLE bot_intent_training_data
  ADD COLUMN IF NOT EXISTS source_langfuse_trace_id TEXT;

-- Helps `import_traces.py` dedup quickly when re-running over a
-- week's worth of traces.
CREATE INDEX IF NOT EXISTS idx_bot_intent_training_data_dedup
  ON bot_intent_training_data (tenant_id, intent, lower(text));

COMMIT;
