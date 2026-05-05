-- Slice 58A — documents table
--
-- Holds every upload regardless of type. Columns named in this
-- migration cover the full 58 family (B-I) so subsequent slices
-- don't churn the schema. Most are nullable until the relevant
-- workflow phase populates them.

CREATE TABLE cip_documents.documents (
  id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                       UUID NOT NULL,

  -- Identity
  uploader_employee_id            UUID,                                   -- nullable to support GDPR strict-erasure (58G); always populated at insert
  subject_employee_id             UUID,                                   -- null until 58D resolves
  source                          TEXT NOT NULL CHECK (source IN ('teams','api','admin')),
  source_message_id               TEXT,                                   -- Teams activity id; null for api/admin
  uploader_hint_text              TEXT,                                   -- "this is for John Smith" — captured at upload

  -- Storage
  s3_bucket                       TEXT NOT NULL,
  s3_key                          TEXT NOT NULL,                          -- {tenantId}/{documentId}/{filename}
  file_name                       TEXT NOT NULL,
  mime_type                       TEXT NOT NULL,
  size_bytes                      BIGINT NOT NULL,
  sha256                          TEXT NOT NULL,                          -- hash reputation + dedup

  -- Lifecycle
  lifecycle_state                 TEXT NOT NULL DEFAULT 'quarantined'
    CHECK (lifecycle_state IN (
      'quarantined','scanning','scan_failed',
      'classifying','awaiting_subject','awaiting_routing',
      'hitl_admin_queue','reclassification_requested',
      'routed','archived',
      'soft_purged','hard_purged','failed'
    )),
  state_reason                    TEXT,
  pre_hitl_state                  TEXT,                                   -- which state to return to after HITL resolves
  pre_purge_state                 TEXT,                                   -- which state to restore to on unpurge

  -- AV (58B populates)
  av_threat_name                  TEXT,
  av_signature_db_age_seconds     INT,

  -- Sensitivity (58B populates)
  sensitivity_tier                TEXT
    CHECK (sensitivity_tier IS NULL OR sensitivity_tier IN ('public','internal','confidential','restricted')),
  sensitivity_evidence            JSONB,

  -- Generic features (58B populates; L1 + L2)
  generic_features                JSONB,
  layout_fingerprint              TEXT,                                   -- perceptual hash for template detection (58I)

  -- Classification (58C populates)
  module                          TEXT,
  doc_type                        TEXT,
  classification_confidence       DOUBLE PRECISION,
  classification_evidence         JSONB,

  -- Type-specific extracted features (58C populates)
  extracted_features              JSONB,
  extraction_confidence           DOUBLE PRECISION,

  -- Subject resolution (58D populates)
  subject_resolution_confidence   DOUBLE PRECISION,
  subject_resolution_evidence     JSONB,

  -- Routing (58E populates)
  downstream_workflow_id          TEXT,
  downstream_workflow_type        TEXT,
  downstream_module_record_id     TEXT,                                   -- TEXT not UUID — some modules may use composite IDs
  prior_module                    TEXT,                                   -- 58F: forensic trail across reclassifications
  prior_doc_type                  TEXT,

  -- Reclassification (58F populates)
  reclassification_in_flight      BOOLEAN NOT NULL DEFAULT false,
  reclassification_request_id     UUID,
  reclassification_count          INT NOT NULL DEFAULT 0,

  -- Timestamps
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  scanned_at                      TIMESTAMPTZ,
  classified_at                   TIMESTAMPTZ,
  routed_at                       TIMESTAMPTZ,
  archived_at                     TIMESTAMPTZ,
  soft_purged_at                  TIMESTAMPTZ,
  hard_purged_at                  TIMESTAMPTZ,
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Integrity constraints — these only fire when the doc reaches the relevant lifecycle state
  CONSTRAINT documents_subject_required_post_routing
    CHECK (lifecycle_state NOT IN ('routed','archived') OR subject_employee_id IS NOT NULL),
  CONSTRAINT documents_module_required_post_classification
    CHECK (lifecycle_state NOT IN ('awaiting_subject','awaiting_routing','routed','archived') OR module IS NOT NULL)
);

CREATE INDEX documents_tenant_state_idx ON cip_documents.documents(tenant_id, lifecycle_state);
CREATE INDEX documents_uploader_idx ON cip_documents.documents(tenant_id, uploader_employee_id) WHERE uploader_employee_id IS NOT NULL;
CREATE INDEX documents_subject_idx ON cip_documents.documents(tenant_id, subject_employee_id) WHERE subject_employee_id IS NOT NULL;
CREATE INDEX documents_module_doctype_idx ON cip_documents.documents(tenant_id, module, doc_type) WHERE module IS NOT NULL;
CREATE INDEX documents_sha256_idx ON cip_documents.documents(tenant_id, sha256);
CREATE INDEX documents_layout_fp_idx ON cip_documents.documents(tenant_id, layout_fingerprint) WHERE layout_fingerprint IS NOT NULL;

-- updated_at trigger — keep this consistent with anything else in the schema
CREATE OR REPLACE FUNCTION cip_documents.set_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER documents_updated_at_trg
  BEFORE UPDATE ON cip_documents.documents
  FOR EACH ROW EXECUTE FUNCTION cip_documents.set_updated_at();
