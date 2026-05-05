-- Slice 58A — audit_events table (partitioned by month)
--
-- Append-only log spanning every doc-related event across the
-- 58 family. 7-year retention (HIPAA-safe ceiling); 58G adds the
-- monthly partition rotation cron. Initial partition seeded here
-- so inserts work immediately.

CREATE TABLE cip_documents.audit_events (
  id                UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL,
  document_id       UUID NOT NULL,                                        -- FK omitted on purpose: events outlive documents (post-purge forensics)
  actor_employee_id UUID,                                                 -- null for system actions
  actor_role        TEXT NOT NULL,                                        -- 'uploader','admin','system','module:cert',...
  event_type        TEXT NOT NULL,
  payload           JSONB,
  occurred_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Composite PK includes occurred_at because the table is range-partitioned on occurred_at
  PRIMARY KEY (id, occurred_at),

  CONSTRAINT audit_events_event_type_check CHECK (event_type IN (
    'uploaded','scanned','quarantined','scan_failed',
    'sensitivity_assigned','generic_features_extracted','embedding_computed',
    'classified','reclassification_requested','reclassification_approved',
    'reclassification_denied','reclassification_timed_out',
    'reclassified_in_flight','reclassified_post_completion',
    'subject_resolved','subject_picklist_offered','subject_picked',
    'routed','module_record_created','module_workflow_cancelled','revoked',
    'acl_changed','acl_evaluated','url_signed','downloaded','shared',
    'soft_purged','hard_purged','restored',
    'template_matched','template_defined','template_superseded',
    'state_transition'
  ))
) PARTITION BY RANGE (occurred_at);

-- Initial month partition. 58G adds the cron that creates monthly
-- partitions ahead. Hardcoding the bootstrap month here means a
-- fresh deploy always has a writeable partition.
DO $$
DECLARE
  ym TEXT := to_char(NOW(), 'YYYY_MM');
  start_dt DATE := date_trunc('month', NOW())::DATE;
  end_dt   DATE := (date_trunc('month', NOW()) + interval '1 month')::DATE;
BEGIN
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS cip_documents.audit_events_%s PARTITION OF cip_documents.audit_events FOR VALUES FROM (%L) TO (%L)',
    ym, start_dt, end_dt
  );
END $$;

CREATE INDEX audit_events_doc_idx ON cip_documents.audit_events(tenant_id, document_id, occurred_at DESC);
CREATE INDEX audit_events_actor_idx ON cip_documents.audit_events(tenant_id, actor_employee_id, occurred_at DESC) WHERE actor_employee_id IS NOT NULL;
CREATE INDEX audit_events_event_type_idx ON cip_documents.audit_events(tenant_id, event_type, occurred_at DESC);
