-- Slice 58A — per-tenant document routing map
--
-- (module, doc_type) → (taskQueue, workflowType). Defined here so
-- 58E doesn't need a schema migration; 58E populates rows.
--
-- Resolution at compare time (58E):
--   1. exact (tenant, module, doc_type)
--   2. fall back to (tenant, module, '*')
--   3. no match → doc transitions to hitl_admin_queue with
--      state_reason='no_routing_rule'

CREATE TABLE cip_documents.document_routing_map (
  tenant_id          UUID NOT NULL,
  module             TEXT NOT NULL,
  doc_type           TEXT NOT NULL,                 -- '*' = catchall for module
  task_queue         TEXT NOT NULL,
  workflow_type      TEXT NOT NULL,
  enabled            BOOLEAN NOT NULL DEFAULT true,
  notes              TEXT,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by         UUID,                          -- employee_id; null for seed
  PRIMARY KEY (tenant_id, module, doc_type)
);

CREATE INDEX document_routing_map_tenant_module_idx
  ON cip_documents.document_routing_map(tenant_id, module, enabled);
