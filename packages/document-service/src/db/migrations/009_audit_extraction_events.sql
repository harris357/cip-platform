-- Slice 58C-FIX — extend audit_events_event_type_check to cover the
-- extraction-failure events 58C emits (and 58D will emit).
--
-- 58A's seed list missed the extraction events the cross-queue
-- strategy proxy uses (`extraction_failed`, `extraction_completed`)
-- and the failure shapes 58D needs (`classify_failed`,
-- `subject_resolution_failed`). Without this ALTER, run-extraction-
-- strategy.activity's recordFailure() throws a CHECK violation when
-- the strategy fails — losing the forensic trail for every error.
--
-- Pre-flight verified manually inside the cluster: the parent
-- partitioned table's CHECK alteration cascades to existing
-- partitions automatically (PG14+ behaviour), and the existing
-- `audit_events_2026_05` row count is preserved.
--
-- 'extracted' (used by run-extraction-strategy on success) is renamed
-- to 'extraction_completed' for naming consistency. The success path
-- in run-extraction-strategy.activity.ts is updated in this same slice.

ALTER TABLE cip_documents.audit_events
  DROP CONSTRAINT audit_events_event_type_check;

ALTER TABLE cip_documents.audit_events
  ADD CONSTRAINT audit_events_event_type_check CHECK (event_type = ANY (ARRAY[
    'uploaded','scanned','quarantined','scan_failed',
    'sensitivity_assigned','generic_features_extracted','embedding_computed',
    'classified','classify_failed','reclassification_requested',
    'reclassification_approved','reclassification_denied',
    'reclassification_timed_out','reclassified_in_flight',
    'reclassified_post_completion','subject_resolved',
    'subject_picklist_offered','subject_picked','subject_resolution_failed',
    'routed','module_record_created','module_workflow_cancelled','revoked',
    'acl_changed','acl_evaluated','url_signed','downloaded','shared',
    'soft_purged','hard_purged','restored','template_matched','template_defined',
    'template_superseded','state_transition',
    'extraction_started','extraction_completed','extraction_failed'
  ]::text[]));
