-- Slice 58A — Row-Level Security policies
--
-- Two layers:
--   1. Tenant isolation (mandatory for every read).
--   2. Lifecycle-state-based read gate (quarantined/scanning are
--      invisible even to tenant admins; routed/archived defer to
--      module-level ACL).
--
-- GUCs set by withActorContext() in src/db/rls.ts before any query:
--   app.current_tenant_id            (UUID)
--   app.current_employee_id          (UUID)
--   app.actor_role                   (text)
--   app.has_documents_admin_read     (bool as text 'true'/'false')
--   app.has_documents_admin_unpurge  (bool)
--   app.has_module_read_for_<module> (bool, dynamic per module)

ALTER TABLE cip_documents.documents          ENABLE ROW LEVEL SECURITY;
ALTER TABLE cip_documents.document_embeddings ENABLE ROW LEVEL SECURITY;
ALTER TABLE cip_documents.audit_events       ENABLE ROW LEVEL SECURITY;
ALTER TABLE cip_documents.document_routing_map ENABLE ROW LEVEL SECURITY;

-- ── Tenant isolation (catch-all; blocks cross-tenant reads regardless of state) ──
CREATE POLICY documents_tenant_isolation ON cip_documents.documents
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID);

CREATE POLICY document_embeddings_tenant_isolation ON cip_documents.document_embeddings
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID);

CREATE POLICY audit_events_tenant_isolation ON cip_documents.audit_events
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID);

CREATE POLICY routing_map_tenant_isolation ON cip_documents.document_routing_map
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID);

-- ── State-based read gate on documents (the access matrix from 58A) ──
--
-- The CASE-style policy expresses the access matrix exactly.  Layered
-- on top of tenant isolation; both must pass for SELECT to succeed.
CREATE POLICY documents_lifecycle_read ON cip_documents.documents FOR SELECT USING (
  -- system actor (worker/temporal): unrestricted within tenant
  current_setting('app.actor_role', true) = 'system'

  -- uploader: always sees own (any state except hard_purged)
  OR (
    uploader_employee_id IS NOT NULL
    AND uploader_employee_id = NULLIF(current_setting('app.current_employee_id', true), '')::UUID
    AND lifecycle_state <> 'hard_purged'
  )

  -- doc-service admin: forensic visibility on every state including pre-classified + soft-purged + failed
  OR current_setting('app.has_documents_admin_read', true) = 'true'

  -- subject + module-permitted readers: only post-routing
  OR (
    lifecycle_state IN ('routed','archived')
    AND (
      (subject_employee_id IS NOT NULL
        AND subject_employee_id = NULLIF(current_setting('app.current_employee_id', true), '')::UUID)
      OR (
        module IS NOT NULL
        AND current_setting('app.has_module_read_for_' || module, true) = 'true'
      )
    )
  )

  -- HITL queue + reclassification queue: gated on documents.admin.read
  OR (
    lifecycle_state IN ('hitl_admin_queue','reclassification_requested')
    AND current_setting('app.has_documents_admin_read', true) = 'true'
  )

  -- soft-purged: documents.admin.unpurge only
  OR (
    lifecycle_state = 'soft_purged'
    AND current_setting('app.has_documents_admin_unpurge', true) = 'true'
  )
);

-- ── Embedding gate: same access shape as documents (denormalised join is too expensive in policy; readers join via app code) ──
CREATE POLICY document_embeddings_read ON cip_documents.document_embeddings FOR SELECT USING (
  current_setting('app.actor_role', true) = 'system'
  OR current_setting('app.has_documents_admin_read', true) = 'true'
);

-- ── Audit events: read-gated on documents.audit.read ──
-- Audit visibility is a separate permission from document content visibility — auditors
-- may read every event without being able to read the document bytes.
CREATE POLICY audit_events_read ON cip_documents.audit_events FOR SELECT USING (
  current_setting('app.actor_role', true) = 'system'
  OR current_setting('app.has_documents_audit_read', true) = 'true'
  OR current_setting('app.has_documents_admin_read', true) = 'true'
);

-- ── Routing map: admin-only writes, all-tenant-actors-can-read ──
-- The map's contents are not sensitive (just routing rules). Reads
-- happen during workflow dispatch; writes via admin tools (58E).
CREATE POLICY routing_map_read ON cip_documents.document_routing_map FOR SELECT USING (true);
