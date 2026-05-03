-- Slice 55: bot_turn_metrics columns for the grammar router.
--
-- Lets us answer:
--   - What fraction of turns matched a grammar pattern? (`grammar_matched`)
--   - Which patterns are firing? (`grammar_pattern`)
--   - On a match, what was the extraction outcome?
--   - Which tool did the extractor handle?
--
-- All nullable — pre-Slice-55 rows simply have nulls. Pre-rollout rows
-- (with `lg.grammar_router_enabled = false` for a tenant) also have
-- grammar_matched=false.

ALTER TABLE bot_turn_metrics
  ADD COLUMN IF NOT EXISTS grammar_matched     BOOLEAN  NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS grammar_pattern     TEXT,
  ADD COLUMN IF NOT EXISTS extraction_outcome  TEXT,    -- complete | ambiguous | missing | no_match | null
  ADD COLUMN IF NOT EXISTS extraction_tool     TEXT;
