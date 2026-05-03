-- Slice 55: tunables for the grammar router + extractor framework.
--
-- enabled defaults to FALSE for safe rollout — existing turns continue
-- to behave exactly as today. Operators flip to true tenant-by-tenant
-- after watching shadow telemetry.

INSERT INTO bot_tunables (tenant_id, key, value_json, notes) VALUES
  ('00000000-0000-0000-0000-000000000000', 'lg.grammar_router_enabled', 'false',
   'Per-tenant kill switch for the grammar router + extractor framework. Default false for safe rollout; flip true tenant-by-tenant after observing shadow metrics.'),
  ('00000000-0000-0000-0000-000000000000', 'lg.extractor_db_timeout_ms', '500',
   'Hard timeout for DB-resolution helpers in extractors. Exceeded → extractor returns no_match → graph falls through to planner.')
ON CONFLICT (tenant_id, key) DO NOTHING;

-- Permission catalog entry for /teach + bot_intent_examples MCP tools.
-- Reuses the bot.metrics.read permission (same admin gate as /turn).
-- No new permission needed — listed here only as documentation.
--
-- (Migration 022 created bot.metrics.read; we just reuse it.)
