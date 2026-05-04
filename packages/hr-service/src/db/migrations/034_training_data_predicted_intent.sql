-- Slice 56L: preserve the original (potentially wrong) prediction on
-- bot_intent_training_data rows so an admin relabel doesn't destroy
-- audit/reporting context.
--
-- Why this is a real problem:
--   - bot_turn_metrics has classifier_intent, but rows roll out at 90
--     days (slice 46d retention CronJob). bot_intent_training_data
--     rows live forever. Once metrics ages out, the original prediction
--     for a corrected training row is permanently lost.
--   - Hand-edits to /teach rows or manual_csv rows have no upstream
--     metric row at all — predicted_intent on the training row itself
--     is the only place to record "this is what was originally
--     predicted vs what we corrected to."
--
-- Use cases this enables:
--   - Confusion-matrix reporting: "which intents were wrongly chosen
--     for which phrasings?" — straight SELECT on this table, no
--     bot_turn_metrics join required.
--   - Hard-negative mining (future): the (text, predicted_intent)
--     pair tells the trainer "this text is NOT the predicted_intent" —
--     trains the boundary from the negative side.
--   - Audit trail for QA: see at-a-glance which corrections changed
--     the label vs which were already correct on import.
--
-- Backfill: existing rows get predicted_intent = intent (i.e. "we have
-- no record of a wrong prediction; assume the current intent IS what
-- was predicted"). For tier-3 confusion_correction rows we'll re-import
-- correctly going forward.

BEGIN;

ALTER TABLE bot_intent_training_data
  ADD COLUMN IF NOT EXISTS predicted_intent TEXT,
  ADD COLUMN IF NOT EXISTS predicted_tool   TEXT;

-- Backfill: assume historical rows had predicted == correct (we lost
-- the actual prediction for any prior tier-3 imports, but going forward
-- this column will be populated correctly).
UPDATE bot_intent_training_data
   SET predicted_intent = intent,
       predicted_tool   = tool
 WHERE predicted_intent IS NULL;

-- Helpful index for confusion-matrix queries.
CREATE INDEX IF NOT EXISTS idx_bot_intent_training_data_confusion
  ON bot_intent_training_data (intent, predicted_intent)
  WHERE predicted_intent IS DISTINCT FROM intent;

COMMIT;
