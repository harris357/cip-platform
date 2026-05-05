-- Slice 53 — seed lg.confirm_* tunables for the card-driven write-action
-- confirm gate.
--
-- Replaces the Slice 46b "Reply yes/no." text confirm with an Adaptive
-- Card that carries [Confirm] [Cancel] buttons. The runner reads
-- `lg.confirm_render_mode` when it detects an active interrupt and
-- branches:
--   - 'card' (default) → render confirm card via Action.Execute
--   - 'text'           → existing 46b path (sendActivity with summary
--                         + " Reply yes/no.")
--
-- All three keys read with `getTunable<T>()` and code-resident defaults
-- — falling back to defaults is safe.
--
-- Per-tenant overrides upserted via the bot_tunables admin path; this
-- file just seeds the platform-wide defaults at the zero-UUID sentinel.

INSERT INTO bot_tunables (tenant_id, key, value_json, notes) VALUES
  ('00000000-0000-0000-0000-000000000000', 'lg.confirm_render_mode',         '"card"',
   'Slice 53: rendering mode for the write-action confirm gate. "card" → Adaptive Card with [Confirm] [Cancel] (Action.Execute). "text" → pre-53 behaviour (text + pattern-matched yes/no).'),
  ('00000000-0000-0000-0000-000000000000', 'lg.confirm_card_ttl_seconds',    '600',
   'Slice 53: max age of a confirm card before clicks are rejected with an "Action expired" card. Anti-replay guard. Default 10 min.'),
  ('00000000-0000-0000-0000-000000000000', 'lg.confirm_card_max_arg_chars',  '300',
   'Slice 53: per-arg truncation cap inside the confirm card FactSet body. Long arg values get sliced to keep the card readable.')
ON CONFLICT (tenant_id, key) DO NOTHING;
