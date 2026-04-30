-- Slice 32 — HR action audit log.
-- Append-only at the application level (no UPDATE / DELETE in any code).
-- Every successful or failed HR-action tool/endpoint call writes one row.
-- Not a column-level audit (use pgaudit / temporal tables for that — out of scope).
-- Not a security event log (KC's own audit + SIEM cover that).

CREATE TABLE IF NOT EXISTS hr_actions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID NOT NULL,
  actor_employee_id  UUID NOT NULL REFERENCES employees(id),
  action_type        TEXT NOT NULL,
  target_employee_id UUID REFERENCES employees(id),
  payload            JSONB NOT NULL DEFAULT '{}'::jsonb,
  result             TEXT NOT NULL CHECK (result IN ('success', 'failed')),
  error_code         TEXT,
  error_message      TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE hr_actions ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON hr_actions
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID);

-- Common query: "show recent actions affecting this employee"
CREATE INDEX IF NOT EXISTS idx_hr_actions_tenant_target
  ON hr_actions(tenant_id, target_employee_id, created_at DESC);

-- Common query: "show recent actions performed by this HR rep"
CREATE INDEX IF NOT EXISTS idx_hr_actions_tenant_actor
  ON hr_actions(tenant_id, actor_employee_id, created_at DESC);
