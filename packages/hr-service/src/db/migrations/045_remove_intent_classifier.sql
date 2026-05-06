-- Slice 61: remove the intent-classifier subsystem (slice 56 family)
-- AND the grammar/extractor pre-router (slice 55).
--
-- Pre-flight: lg.classifier_enabled, lg.classifier_honor_decisions, and
-- lg.grammar_router_enabled are all `false` platform-wide (set 2026-05-06).
-- The bot has been validated to work with both layers off (LLM-only tool
-- selection at 1.3-1.9s/turn). This migration drops the leftover tunable
-- rows and the data tables.

-- Tunable rows: classifier (slice 56) + grammar router (slice 27).
DELETE FROM bot_tunables WHERE key LIKE 'lg.classifier_%';
DELETE FROM bot_tunables WHERE key LIKE 'lg.grammar_router_%';

-- Intent-classifier data tables (per user direction 2026-05-06).
DROP TABLE IF EXISTS training_data         CASCADE;
DROP TABLE IF EXISTS bot_intent_examples   CASCADE;
DROP TABLE IF EXISTS model_runs            CASCADE;
DROP TABLE IF EXISTS bot_turn_feedback     CASCADE;

-- Grammar router metrics (slice 26 created the table; deleting now since
-- the writer goes away). IF EXISTS in case the table was never created or
-- already dropped.
DROP TABLE IF EXISTS grammar_router_metrics CASCADE;
