-- Slice 58C — seed classify_confidence_threshold tunable for doc-service.
--
-- Below this confidence the classify phase shunts the doc into
-- hitl_admin_queue with pre_hitl_state='classifying' instead of advancing
-- to extract. Per-tenant overrides are upserted by admin tools (slice 58E).
--
-- The doc-service tunable loader reads this from cip_hr.bot_tunables via
-- the same shadow pattern as the rest of the documents.* keys (see slice
-- 58B's 037_documents_tunables.sql).

INSERT INTO bot_tunables (tenant_id, key, value_json, notes) VALUES
  ('00000000-0000-0000-0000-000000000000', 'documents.classify_confidence_threshold', '0.75',
   'Slice 58C: minimum classifier confidence to skip HITL admin queue. Below this, the doc lands in hitl_admin_queue with pre_hitl_state=classifying.')
ON CONFLICT (tenant_id, key) DO NOTHING;
