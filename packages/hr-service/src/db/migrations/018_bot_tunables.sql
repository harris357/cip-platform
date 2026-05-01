-- Slice 45: bot_tunables — runtime-tunable thresholds, patterns, and
-- step counts for the LangGraph runtime.
--
-- Lookup precedence (per request):
--   1. (tenant_id = ctx.tenantId, key) — per-tenant override
--   2. (tenant_id = NULL, key)         — global default
--   3. code-resident fallback constant — defense in depth
--
-- value_json is JSONB so one row can hold a number, string, or array
-- without schema gymnastics. Bot fetches the whole tenant set in one
-- query and caches per-tenant for 5 minutes (matches routing-rules
-- cache TTL).
--
-- Tech-debt note: this lives in cip_hr alongside routing_rules for
-- historical reasons (platform-core has no DB infrastructure today).
-- A future "platform schema split" cleanup may move both tables to a
-- dedicated cip_platform database.

-- Global defaults use the sentinel zero UUID for tenant_id; per-tenant
-- overrides use the real tenant_id. PRIMARY KEY enforces uniqueness
-- across both. (Postgres doesn't allow function-based composite PKs,
-- so the sentinel is the cleanest way to keep one PK + simple lookups.)
CREATE TABLE IF NOT EXISTS bot_tunables (
  tenant_id   UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  key         TEXT NOT NULL,
  value_json  JSONB NOT NULL,
  notes       TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by  TEXT,
  PRIMARY KEY (tenant_id, key)
);

-- Initial seed — global defaults for every LangGraph tunable.
-- Per-tenant overrides land via UPDATE/INSERT against (tenant_id, key).
INSERT INTO bot_tunables (tenant_id, key, value_json, notes) VALUES
  ('00000000-0000-0000-0000-000000000000', 'lg.max_steps',                '5',
   'Max plan→execute loops per turn before forcing respond.'),
  ('00000000-0000-0000-0000-000000000000', 'lg.triage_clarify_threshold', '0.7',
   'Triage confidence threshold for the clarification path. Below this, planner runs anyway.'),
  ('00000000-0000-0000-0000-000000000000', 'lg.max_recent_messages',      '8',
   'How many prior messages flow into plan context (older trimmed at runtime).'),
  ('00000000-0000-0000-0000-000000000000', 'lg.affirmation_patterns',
   '["yes","y","confirm","go ahead","do it","ok","okay","sure"]',
   'Lower-cased + trimmed user reply matched against pendingWriteCall to confirm.'),
  ('00000000-0000-0000-0000-000000000000', 'lg.cancellation_patterns',
   '["no","n","cancel","stop","never mind","nevermind","wait"]',
   'Lower-cased + trimmed user reply matched against pendingWriteCall to cancel.'),
  ('00000000-0000-0000-0000-000000000000', 'lg.authorized_write_verbs',
   '["disable","off-board","offboard","create","add","assign","grant","revoke","remove","fire","approve","reject"]',
   'Verb match in user message bypasses the write-action confirmation gate (entity also required).'),
  ('00000000-0000-0000-0000-000000000000', 'lg.default_engine',           '"legacy"',
   'Per-tenant engine default. Values: "legacy" or "langgraph". Per-thread /lg overrides this.')
ON CONFLICT (tenant_id, key) DO NOTHING;
