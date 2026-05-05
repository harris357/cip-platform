-- Slice 58E — default routing map seed.
--
-- Seeds the platform-default cert routing rule against the zero-UUID
-- tenant sentinel. The 58E resolver falls back through:
--   (tenantId, module, doc_type) → (tenantId, module, '*')
--   → (zero-UUID, module, doc_type) → (zero-UUID, module, '*')
-- so this row matches every cert doc for every tenant unless the
-- tenant has its own override.
--
-- New tenants don't need this row inserted under their tenant_id —
-- the zero-UUID fallback covers them. If a tenant wants a different
-- cert workflow, they call documents_routing_map_set with their
-- tenant scope.
--
-- (Slice doc body referenced 039_routing_map_seed.sql on hr-service —
-- that was wrong. The routing_map table is in cip_documents, so the
-- seed belongs on doc-service.)

INSERT INTO cip_documents.document_routing_map
  (tenant_id, module, doc_type, task_queue, workflow_type)
VALUES
  ('00000000-0000-0000-0000-000000000000', 'certificate', '*',
   'cip-hr-tasks', 'CertificationProcessingWorkflow')
ON CONFLICT (tenant_id, module, doc_type) DO NOTHING;
