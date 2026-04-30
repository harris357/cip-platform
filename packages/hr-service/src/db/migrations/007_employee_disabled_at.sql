-- Slice 33: support employee disable workflow.
-- The employees table from Slice 05A doesn't have an active/disabled column.
-- Adding `disabled_at` (NULL = active; non-NULL = disabled at that timestamp).

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ;

-- "show me all active employees" query path:
CREATE INDEX IF NOT EXISTS idx_employees_tenant_active
  ON employees(tenant_id) WHERE disabled_at IS NULL;
