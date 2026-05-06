-- Slice 66: track how each employee was provisioned for compliance / eval.
-- Backfill existing rows as 'unknown' (pre-66 history; locked decision Q2).

BEGIN;

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS onboarding_source TEXT
    CHECK (onboarding_source IN ('admin', 'workflow', 'self', 'unknown'))
    NOT NULL DEFAULT 'unknown';

COMMIT;
