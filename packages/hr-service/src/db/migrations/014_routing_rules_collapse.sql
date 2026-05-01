-- Slice 43: collapse the per-category Stage-2 routing aliases into a
-- single `route` purpose, and add `meta_compose` for the dedicated
-- meta-reply LLM call.
--
-- Removes:
--   bot.route_simple    (was: cip-chat)
--   bot.route_careful   (was: cip-router-careful)
--   bot.route_reasoning (was: cip-reasoning)
--
-- Adds:
--   bot.route           → mistral-small-latest (function calling, 30+ tools)
--   bot.meta_compose    → open-mistral-nemo    (compose meta menu, no tool calls)
--
-- Per-tenant overrides for the retired purposes will need to be re-added
-- against `route`. Idempotent: the DELETE skips missing rows, the INSERT
-- ON CONFLICT updates if re-run.

DELETE FROM routing_rules
 WHERE service = 'bot'
   AND purpose IN ('route_simple', 'route_careful', 'route_reasoning');

INSERT INTO routing_rules (service, purpose, alias, notes) VALUES
  ('bot', 'route',        'mistral-small-latest',
   'Function calling over the full permission-filtered tool catalog (Slice 43).'),
  ('bot', 'meta_compose', 'open-mistral-nemo',
   'Composes the meta reply ("what can I help with") from the user''s permitted tools (Slice 43).')
ON CONFLICT (service, purpose) DO UPDATE
  SET alias      = EXCLUDED.alias,
      notes      = EXCLUDED.notes,
      updated_at = NOW(),
      updated_by = 'migration-014';
