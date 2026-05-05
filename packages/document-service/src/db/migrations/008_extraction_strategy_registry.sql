-- Slice 58C — per-tenant extraction strategy registry
--
-- The doc-service classify+extract phase loop dispatches each (module,
-- doc_type) to a strategy named in this table. Strategies are activities
-- registered on a per-module Temporal task queue (e.g. cert lives on
-- `cip-hr-tasks`). Doc-service proxies to that queue at runtime; it
-- never imports the strategy implementation.
--
-- Resolution order at lookup time (registry.ts):
--   1. exact   (tenant_id,         module, doc_type)
--   2. wild    (tenant_id,         module, '*')
--   3. global  (00000000-...zero,  module, doc_type)
--   4. global  (00000000-...zero,  module, '*')
--
-- A '*' tenant_id is NOT used here — UUID typed column. The zero-UUID
-- sentinel is the platform-default catchall row.
--
-- Hard rule #1 (memory): NEVER hand-curate this in code. Tenants that
-- need overrides INSERT a row; the slice 58E admin tools own the writes.

CREATE TABLE cip_documents.extraction_strategies (
  tenant_id          UUID NOT NULL,
  module             TEXT NOT NULL,
  doc_type           TEXT NOT NULL,                       -- '*' = wildcard for any doc_type in module
  strategy_name      TEXT NOT NULL,                       -- human-readable identifier; not directly invoked
  task_queue         TEXT NOT NULL,                       -- which Temporal queue runs the activity
  activity_name      TEXT NOT NULL,                       -- name registered on the worker (e.g. 'extractCertFeaturesActivity')
  config_json        JSONB NOT NULL DEFAULT '{}'::jsonb,  -- per-strategy parameters; passed through to activity input
  enabled            BOOLEAN NOT NULL DEFAULT true,
  notes              TEXT,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by         UUID,                                -- employee_id; null for seed
  PRIMARY KEY (tenant_id, module, doc_type)
);

CREATE INDEX extraction_strategies_tenant_module_idx
  ON cip_documents.extraction_strategies(tenant_id, module, enabled);

-- ── RLS: tenant isolation + global-default catchall ──
ALTER TABLE cip_documents.extraction_strategies ENABLE ROW LEVEL SECURITY;

CREATE POLICY extraction_strategies_tenant_isolation
  ON cip_documents.extraction_strategies
  USING (
    tenant_id = current_setting('app.current_tenant_id')::UUID
    OR tenant_id = '00000000-0000-0000-0000-000000000000'::UUID
  );

-- Reads are unrestricted within the tenant-isolation gate; the registry
-- runs under a system actor context anyway. Writes happen via slice 58E
-- admin tools — no INSERT/UPDATE policy needed today.
CREATE POLICY extraction_strategies_read
  ON cip_documents.extraction_strategies
  FOR SELECT USING (true);

-- ── Seed: certificate strategy (catchall doc_type) ──
-- '*' for tenant_id is invalid (UUID column); use the zero-UUID
-- sentinel as the platform default. doc_type='*' is the catchall —
-- any cert sub-type (cpr, first_aid, ...) routes through the same
-- vision agent until a per-tenant override creates a more specific row.
INSERT INTO cip_documents.extraction_strategies
  (tenant_id, module, doc_type, strategy_name, task_queue, activity_name, config_json, notes)
VALUES (
  '00000000-0000-0000-0000-000000000000',
  'certificate',
  '*',
  'extract_certificate_default',
  'cip-hr-tasks',
  'extractCertFeaturesActivity',
  '{}'::jsonb,
  'Slice 58C platform default. Wraps the existing hr-service vision agent. Slice 58E admin tools allow per-tenant or per-doc-type overrides.'
)
ON CONFLICT (tenant_id, module, doc_type) DO NOTHING;
