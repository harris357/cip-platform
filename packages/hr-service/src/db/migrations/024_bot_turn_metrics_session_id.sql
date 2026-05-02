-- Slice 46e follow-up: surface the Langfuse session id on /turn.
--
-- The bot's state.sessionId (Slice 48 follow-up) groups consecutive
-- turns within a continuous interaction (idle gap > lg.session_timeout_minutes
-- mints a new one). Persisting it here lets bot_metrics_get_turn build
-- a deep link to the Langfuse session view, alongside the existing
-- trace deep link.
--
-- Nullable for rows written before this column existed.

ALTER TABLE bot_turn_metrics
  ADD COLUMN IF NOT EXISTS session_id TEXT;
