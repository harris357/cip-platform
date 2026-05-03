-- Slice 55: bot_intent_examples table — backing store for the /teach
-- admin slash command and the "Add to training set" action on /turn cards.
--
-- Three sources feed this table:
--   - 'teach'      — admin typed /teach in Teams
--   - 'turn_label' — admin tapped "Add to training set" on a /turn card
--   - 'manual_csv' — bulk import from packages/intent-classifier/training/manual_examples.csv
--
-- Reviewed=false rows are pending human review before being merged into
-- training_data.csv (consumed by Slice 56's sklearn training pipeline).
--
-- Tenant-scoped — every read filters by tenant_id. No cross-tenant
-- access from the /teach command.

CREATE TABLE IF NOT EXISTS bot_intent_examples (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL,
  added_by        TEXT NOT NULL,                          -- employee_id of the operator
  added_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  text            TEXT NOT NULL,                          -- user-facing phrasing being labelled
  intent          TEXT NOT NULL,                          -- e.g. 'disable_employee'
  tool            TEXT,                                   -- e.g. 'employee_disable' (null when next_action != call_tool)
  next_action     TEXT NOT NULL,                          -- call_tool | clarify | answer_directly | unknown
  source          TEXT NOT NULL DEFAULT 'teach',          -- teach | turn_label | manual_csv
  source_turn_id  TEXT,                                   -- when source='turn_label', the originating turn_id
  notes           TEXT,
  reviewed        BOOLEAN NOT NULL DEFAULT false,
  CHECK (next_action IN ('call_tool', 'clarify', 'answer_directly', 'unknown')),
  CHECK (source     IN ('teach', 'turn_label', 'manual_csv'))
);

CREATE INDEX IF NOT EXISTS idx_bot_intent_examples_tenant_unreviewed
  ON bot_intent_examples (tenant_id, reviewed) WHERE NOT reviewed;
CREATE INDEX IF NOT EXISTS idx_bot_intent_examples_added_at
  ON bot_intent_examples (added_at DESC);
