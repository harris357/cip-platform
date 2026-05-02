-- Slice 46e follow-up: capture the actual Langfuse trace_id per turn.
--
-- The bot's turnId (8-char hex from randomUUID slice) is OUR identifier
-- for cross-system correlation. Langfuse traces carry their own UUID
-- trace_id (set by OTEL when the span is created). Direct-linking to
-- a trace requires the Langfuse trace_id, not ours, so we capture it
-- after invoke and persist alongside the turn row.
--
-- Nullable because rows written before this column existed don't have
-- it, and the Langfuse callback may fail / not be available in some
-- non-Langfuse setups.

ALTER TABLE bot_turn_metrics
  ADD COLUMN IF NOT EXISTS langfuse_trace_id TEXT;
