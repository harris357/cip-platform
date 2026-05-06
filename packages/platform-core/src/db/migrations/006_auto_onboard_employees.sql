-- Slice 66: per-tenant gate for auto-onboarding employees on first HR access.
-- Default true preserves current behavior (every authenticated user becomes
-- an Employee). Operators flip false for tenants where Employee = explicit
-- HR onboarding (e.g., financial users shouldn't become employees).

BEGIN;

ALTER TABLE cip_platform.tenant_settings
  ADD COLUMN IF NOT EXISTS auto_onboard_employees BOOLEAN NOT NULL DEFAULT true;

COMMIT;
