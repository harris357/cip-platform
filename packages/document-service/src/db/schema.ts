import {
  pgSchema, uuid, text, timestamp, boolean, integer, bigint,
  doublePrecision, jsonb, primaryKey, index, check
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

// All doc-service tables live in the cip_documents schema. The schema
// itself is created by migration 001 (drizzle-orm doesn't manage that
// for us — it expects the schema to exist).
export const cipDocuments = pgSchema('cip_documents')

// Lifecycle states match the CHECK constraint in 002_documents_table.sql
// exactly. Any addition here must add to the CHECK in the same commit.
export const LIFECYCLE_STATES = [
  'quarantined','scanning','scan_failed',
  'classifying','awaiting_subject','awaiting_routing',
  'hitl_admin_queue','reclassification_requested',
  'routed','archived',
  'soft_purged','hard_purged','failed',
] as const
export type LifecycleState = typeof LIFECYCLE_STATES[number]

export const SENSITIVITY_TIERS = ['public','internal','confidential','restricted'] as const
export type SensitivityTier = typeof SENSITIVITY_TIERS[number]

export const documents = cipDocuments.table('documents', {
  id:                            uuid('id').primaryKey().defaultRandom(),
  tenantId:                      uuid('tenant_id').notNull(),

  // Identity
  uploaderEmployeeId:            uuid('uploader_employee_id'),
  subjectEmployeeId:             uuid('subject_employee_id'),
  source:                        text('source').notNull(),
  sourceMessageId:               text('source_message_id'),
  uploaderHintText:              text('uploader_hint_text'),

  // Storage
  s3Bucket:                      text('s3_bucket').notNull(),
  s3Key:                         text('s3_key').notNull(),
  fileName:                      text('file_name').notNull(),
  mimeType:                      text('mime_type').notNull(),
  sizeBytes:                     bigint('size_bytes', { mode: 'number' }).notNull(),
  sha256:                        text('sha256').notNull(),

  // Lifecycle
  lifecycleState:                text('lifecycle_state').notNull().default('quarantined'),
  stateReason:                   text('state_reason'),
  preHitlState:                  text('pre_hitl_state'),
  prePurgeState:                 text('pre_purge_state'),

  // AV
  avThreatName:                  text('av_threat_name'),
  avSignatureDbAgeSeconds:       integer('av_signature_db_age_seconds'),

  // Sensitivity
  sensitivityTier:               text('sensitivity_tier'),
  sensitivityEvidence:           jsonb('sensitivity_evidence'),

  // Generic features
  genericFeatures:               jsonb('generic_features'),
  layoutFingerprint:             text('layout_fingerprint'),

  // Classification
  module:                        text('module'),
  docType:                       text('doc_type'),
  classificationConfidence:      doublePrecision('classification_confidence'),
  classificationEvidence:        jsonb('classification_evidence'),

  // Type-specific extracted features
  extractedFeatures:             jsonb('extracted_features'),
  extractionConfidence:          doublePrecision('extraction_confidence'),

  // Subject resolution
  subjectResolutionConfidence:   doublePrecision('subject_resolution_confidence'),
  subjectResolutionEvidence:     jsonb('subject_resolution_evidence'),

  // Routing
  downstreamWorkflowId:          text('downstream_workflow_id'),
  downstreamWorkflowType:        text('downstream_workflow_type'),
  downstreamModuleRecordId:      text('downstream_module_record_id'),
  priorModule:                   text('prior_module'),
  priorDocType:                  text('prior_doc_type'),

  // Reclassification
  reclassificationInFlight:      boolean('reclassification_in_flight').notNull().default(false),
  reclassificationRequestId:     uuid('reclassification_request_id'),
  reclassificationCount:         integer('reclassification_count').notNull().default(0),

  // Timestamps
  createdAt:                     timestamp('created_at',     { withTimezone: true }).notNull().defaultNow(),
  scannedAt:                     timestamp('scanned_at',     { withTimezone: true }),
  classifiedAt:                  timestamp('classified_at',  { withTimezone: true }),
  routedAt:                      timestamp('routed_at',      { withTimezone: true }),
  archivedAt:                    timestamp('archived_at',    { withTimezone: true }),
  softPurgedAt:                  timestamp('soft_purged_at', { withTimezone: true }),
  hardPurgedAt:                  timestamp('hard_purged_at', { withTimezone: true }),
  updatedAt:                     timestamp('updated_at',     { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  tenantStateIdx:    index('documents_tenant_state_idx').on(t.tenantId, t.lifecycleState),
  uploaderIdx:       index('documents_uploader_idx').on(t.tenantId, t.uploaderEmployeeId),
  subjectIdx:        index('documents_subject_idx').on(t.tenantId, t.subjectEmployeeId),
  moduleDocTypeIdx:  index('documents_module_doctype_idx').on(t.tenantId, t.module, t.docType),
  sha256Idx:         index('documents_sha256_idx').on(t.tenantId, t.sha256),
  layoutFpIdx:       index('documents_layout_fp_idx').on(t.tenantId, t.layoutFingerprint),
}))

export const auditEvents = cipDocuments.table('audit_events', {
  id:               uuid('id').notNull().defaultRandom(),
  tenantId:         uuid('tenant_id').notNull(),
  documentId:       uuid('document_id').notNull(),
  actorEmployeeId:  uuid('actor_employee_id'),
  actorRole:        text('actor_role').notNull(),
  eventType:        text('event_type').notNull(),
  payload:          jsonb('payload'),
  occurredAt:       timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  // Composite PK because the table is range-partitioned on occurred_at
  pk:               primaryKey({ columns: [t.id, t.occurredAt] }),
  docIdx:           index('audit_events_doc_idx').on(t.tenantId, t.documentId, t.occurredAt),
  actorIdx:         index('audit_events_actor_idx').on(t.tenantId, t.actorEmployeeId, t.occurredAt),
  eventTypeIdx:     index('audit_events_event_type_idx').on(t.tenantId, t.eventType, t.occurredAt),
}))

// pgvector custom type — drizzle doesn't have first-class vector
// support yet (as of 0.41), so we represent it as the raw `text`
// type and convert at query time via `pgvector` npm helpers.  The
// migration creates the column as `vector(1024)`; reads/writes
// from app code go through the pgvector client wrapper.
export const documentEmbeddings = cipDocuments.table('document_embeddings', {
  documentId:       uuid('document_id').primaryKey(),
  tenantId:         uuid('tenant_id').notNull(),
  // embedding column is vector(1024) at the SQL level — handled by pgvector npm at insert time
  embeddingModel:   text('embedding_model').notNull(),
  computedAt:       timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  tenantIdx:        index('document_embeddings_tenant_idx').on(t.tenantId),
}))

// Slice 58C — per-tenant strategy registry. Resolution falls back through
// (tenant, module, doc_type) → (tenant, module, '*') → (zero-UUID, ...).
// Slice 58E — added optional mime_filter column for MIME-aware routing
// (NULL = matches every MIME class; otherwise matches the canonical
// MimeClass string returned by classifyMime()).
export const extractionStrategies = cipDocuments.table('extraction_strategies', {
  tenantId:         uuid('tenant_id').notNull(),
  module:           text('module').notNull(),
  docType:          text('doc_type').notNull(),                    // '*' = wildcard
  strategyName:     text('strategy_name').notNull(),
  taskQueue:        text('task_queue').notNull(),
  activityName:     text('activity_name').notNull(),
  configJson:       jsonb('config_json').notNull().default(sql`'{}'::jsonb`),
  enabled:          boolean('enabled').notNull().default(true),
  notes:            text('notes'),
  /** Slice 58E — optional MIME class filter; NULL matches every MIME. */
  mimeFilter:       text('mime_filter'),
  updatedAt:        timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy:        uuid('updated_by'),
}, (t) => ({
  pk:               primaryKey({ columns: [t.tenantId, t.module, t.docType] }),
  tenantModuleIdx:  index('extraction_strategies_tenant_module_idx').on(t.tenantId, t.module, t.enabled),
}))

export const documentRoutingMap = cipDocuments.table('document_routing_map', {
  tenantId:         uuid('tenant_id').notNull(),
  module:           text('module').notNull(),
  docType:          text('doc_type').notNull(),
  taskQueue:        text('task_queue').notNull(),
  workflowType:     text('workflow_type').notNull(),
  enabled:          boolean('enabled').notNull().default(true),
  notes:            text('notes'),
  updatedAt:        timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy:        uuid('updated_by'),
}, (t) => ({
  pk:               primaryKey({ columns: [t.tenantId, t.module, t.docType] }),
  tenantModuleIdx:  index('document_routing_map_tenant_module_idx').on(t.tenantId, t.module, t.enabled),
}))
