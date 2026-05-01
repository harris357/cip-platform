-- Slice 52: streaming-mode tunable for the bot.
--
-- 'none'   — single typing indicator at turn start (Slice 47 default behavior).
-- 'typing' — refresh the typing indicator every lg.streaming_typing_refresh_ms
--            so it doesn't disappear on long turns (Teams typing TTL ~10-15s).
--
-- Per-tenant override possible via INSERT/UPDATE on the (tenant_id, key) pair.
-- Promote a tenant to 'progress' mode in a future slice when adaptive-card
-- progress chips ship.

INSERT INTO bot_tunables (tenant_id, key, value_json, notes) VALUES
  ('00000000-0000-0000-0000-000000000000', 'lg.streaming_mode',          '"typing"',
   'Streaming mode: "none" (no refresh) or "typing" (refresh indicator). Future: "progress" (chips).'),
  ('00000000-0000-0000-0000-000000000000', 'lg.streaming_typing_refresh_ms', '4000',
   'Interval at which to re-send the typing activity during long turns. Teams TTL is ~10-15s.')
ON CONFLICT (tenant_id, key) DO NOTHING;
