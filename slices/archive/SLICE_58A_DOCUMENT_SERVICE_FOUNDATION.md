# Slice 58A — `@cip/document-service` foundation

> **Why this exists:** Today only certificates can be uploaded; the
> entry point hardcodes `process_document` to start
> `CertificationProcessingWorkflow`, the bot drops the user's
> accompanying text, and there's no place for any other doc type to
> land. This slice stands up a new platform-level service that owns
> generic document ingestion, classification, sensitivity scoring,
> feature extraction, and routing — with cert as the first consumer
> (rewritten in 58E to be a downstream module, not the entry point).
>
> 58A delivers **only the foundation**: package scaffolding, helm
> chart (service + ClamAV), `cip_documents` schema, lifecycle state
> machine, RLS policies, permission catalog rows, audit table, and
> the module-side contract every consumer must implement. No actual
> ingestion, classification, or workflow happens yet — that's 58B–E.
> This slice exists so the rest of the family has stable foundations
> to build against in parallel sessions.

---

## Goals

1. Ship `@cip/document-service` as a deployable image alongside the
   existing services. Same patterns as `@cip/hr-service`: TypeScript,
   MCP server surface, Temporal worker, drizzle ORM, helm chart.
2. Stand up ClamAV in `cip-infra` as a dependency (single replica,
   INSTREAM protocol over TCP/3310, NetworkPolicy locking access to
   doc-service only).
3. Create `cip_documents` schema in the existing Postgres instance
   (separate schema, not `cip_hr` — preserves clean extraction path
   if document-service ever moves to its own DB).
4. Define the `documents` and `audit_events` tables with all columns
   needed by 58B-I, even though most will be nullable/unused at this
   slice (avoids schema churn across the family).
5. Define the lifecycle state machine in TS + DB CHECK constraint.
6. Define RLS policies that enforce state-based read gating
   (`quarantined`/`scanning` invisible even to tenant admins).
7. Seed the `documents.*` permission catalog rows.
8. Define the **module-side contract** (`processDocument` +
   `revokeFor` shape) in `@cip/shared` so 58E (cert migration) and
   future modules know what they must implement.
9. Wire EICAR test path against the dev ClamAV so the AV layer is
   provably functional even before 58B uses it.

**Out of scope for this slice:**
- Bot wiring (capture hint text, replace cert fast-path) → 58B
- `DocumentProcessingWorkflow` itself → 58B
- Any activity that reads/writes a document → 58B
- Classification / extraction / subject resolution / routing → 58C/D/E
- Reclassification flow → 58F
- Hard-purge cron → 58G

---

## Files in scope

```
packages/document-service/                                              NEW package
├── package.json                                                        NEW
├── tsconfig.json                                                       NEW
├── Dockerfile                                                          NEW
├── helm/
│   ├── Chart.yaml                                                      NEW
│   ├── values.yaml                                                     NEW
│   └── templates/
│       ├── deployment.yaml                                             NEW
│       ├── service.yaml                                                NEW
│       ├── secret.yaml                                                 NEW (DATABASE_URL_DOCS, S3 creds, JWT verify pubkey)
│       └── networkpolicy.yaml                                          NEW
├── src/
│   ├── index.ts                                                        NEW
│   ├── server.ts                                                       NEW (express + MCP transport)
│   ├── instrumentation.ts                                              NEW (OTEL bootstrap, mirror hr-service)
│   ├── db/
│   │   ├── index.ts                                                    NEW (drizzle client; search_path=cip_documents)
│   │   ├── schema.ts                                                   NEW (drizzle schemas for documents + audit_events + document_embeddings)
│   │   ├── rls.ts                                                      NEW (withTenantRLS + withActorContext)
│   │   └── migrations/
│   │       ├── 001_init_schema.sql                                     NEW (cip_documents schema, search_path)
│   │       ├── 002_documents_table.sql                                 NEW
│   │       ├── 003_audit_events_table.sql                              NEW (partitioned by month)
│   │       ├── 004_document_embeddings_table.sql                       NEW (pgvector, no HNSW per slice 44)
│   │       ├── 005_document_routing_map_table.sql                      NEW (per-tenant routing map; 58E populates)
│   │       ├── 006_rls_policies.sql                                    NEW
│   │       └── 007_seed_permissions.sql                                NEW (inserts into cip_hr.permission_catalog)
│   ├── mcp-server/
│   │   ├── index.ts                                                    NEW (server bootstrap)
│   │   └── auth.ts                                                     NEW (extractAuthContext — JWT verify, mirror hr-service)
│   ├── lifecycle/
│   │   ├── states.ts                                                   NEW (LifecycleState enum + valid transitions)
│   │   └── access-policy.ts                                            NEW (effective_can_read composition rule)
│   ├── av/
│   │   ├── clamav-client.ts                                            NEW (INSTREAM client; thin wrapper over `clamscan` npm pkg)
│   │   └── eicar-test.ts                                               NEW (integration smoke test)
│   └── workers/
│       └── temporal-worker.ts                                          NEW (worker boot; registers no activities yet — 58B onwards)
└── test/
    ├── lifecycle.test.ts                                               NEW (state machine transitions)
    ├── access-policy.test.ts                                           NEW (composition rule unit tests)
    └── av-integration.test.ts                                          NEW (EICAR scan against dev clamd)

infra/k8s/clamav/                                                       NEW chart
├── Chart.yaml                                                          NEW
├── values.yaml                                                         NEW
└── templates/
    ├── deployment.yaml                                                 NEW
    ├── service.yaml                                                    NEW
    ├── configmap-clamd-conf.yaml                                       NEW
    └── networkpolicy.yaml                                              NEW

packages/shared/src/                                                    MOD
├── types/
│   └── document-module-contract.ts                                     NEW (ProcessDocumentInput, RevokeForInput, types)
└── index.ts                                                            MOD (export new types)

packages/hr-service/src/services/permission-catalog-seed.ts             MOD (extend with documents.* permissions; this is the canonical seed list)

scripts/start.ts                                                        MOD (deploy clamav + document-service charts)
scripts/stop.ts                                                         MOD (helm uninstall in reverse dep order)

Makefile                                                                MOD (`make logs svc=document-service` works)

slices/CONTEXT_WORKFLOW.md                                              MOD (add 58A-I to slice map)
```

---

## Hard rules

1. **No reads or writes to `cip_hr` schema from document-service.**
   The only cross-schema reference is the `documents.*` permission
   rows which must be seeded into `cip_hr.permission_catalog` (the
   catalog is the canonical seed across services). After seeding,
   document-service queries permission membership only via the
   existing hr-service MCP `assertPermission` flow (JWT forwarded).
2. **No code in this slice reads or writes a document.** No
   ingestion, no S3 PutObject, no scan, no classification, no
   extraction, no workflow start. Every activity proxy in
   `temporal-worker.ts` is empty — activities arrive in 58B+.
3. **The lifecycle state machine is exhaustive.** Every state must
   be in the TS enum, the DB CHECK constraint, and the RLS access
   policy CASE. Diff the three any time you add a state.
4. **RLS quarantine enforcement is at the database level, not the
   app.** Quarantined/scanning rows must be invisible even when
   the app forgets to filter — the policy denies the read.
5. **Audit retention is 7 years** (HIPAA-safe ceiling). Tunable
   `documents.audit_retention_years = 7` seeded; cron in 58G.
6. **All `documents.*` MCP tools declare `requiredPermission`.**
   Even though no tools are added in this slice, leave the
   `assertPermission` middleware mounted in the MCP server bootstrap
   so 58B's first tool can rely on it.
7. **No dependency on hr-service code.** `@cip/document-service`
   imports only from `@cip/shared`. Cross-service auth = JWT
   forwarding. If you find yourself wanting to import a util from
   `@cip/hr-service`, push it into `@cip/shared` first.
8. **ClamAV image pinned to `clamav/clamav:1.4`.** Don't use
   `:latest` — Cisco Talos rolls breaking config changes between
   minors.
9. **Workflow ID convention preserved**: any workflow.start() in
   58B+ uses `DocumentProcess-${tenantId}-${documentId}` with the
   comment `// Workflow ID pattern: {workflowType}-{tenantId}-{entityId}`
   on the preceding line. (Non-Negotiable #4.)

---

## Schema design

### `cip_documents.documents`

Every column 58B–I will need, declared up front:

```sql
CREATE TABLE cip_documents.documents (
  id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                       UUID NOT NULL,

  -- Identity
  uploader_employee_id            UUID NOT NULL,
  subject_employee_id             UUID,                       -- null until 58D resolves
  source                          TEXT NOT NULL CHECK (source IN ('teams','api','admin')),
  source_message_id               TEXT,                       -- Teams activity id; null for api/admin
  uploader_hint_text              TEXT,                       -- "this is for John Smith" — captured at upload (58B)

  -- Storage
  s3_bucket                       TEXT NOT NULL,
  s3_key                          TEXT NOT NULL,              -- {tenantId}/{documentId}/{filename}
  file_name                       TEXT NOT NULL,
  mime_type                       TEXT NOT NULL,
  size_bytes                      BIGINT NOT NULL,
  sha256                          TEXT NOT NULL,              -- for hash reputation + dedup

  -- Lifecycle
  lifecycle_state                 TEXT NOT NULL DEFAULT 'quarantined'
    CHECK (lifecycle_state IN (
      'quarantined','scanning','scan_failed',
      'classifying','awaiting_subject','awaiting_routing',
      'hitl_admin_queue',
      'reclassification_requested',                         -- 58F: pending admin approval to reclassify a routed/archived doc
      'routed','archived',                                  -- 'routed' covers "module workflow handed off, awaiting callback" (no separate awaiting_module_callback DB state — that's a workflow-phase concept only, see 58F)
      'soft_purged','hard_purged','failed'
    )),
  state_reason                    TEXT,                       -- human-readable note ("low classification confidence")
  pre_hitl_state                  TEXT,                       -- which state to return to after HITL resolves
  pre_purge_state                 TEXT,                       -- which state to restore to on unpurge

  -- AV
  av_threat_name                  TEXT,                       -- non-null iff lifecycle_state='scan_failed'
  av_signature_db_age_seconds     INT,                        -- snapshot at scan time

  -- Sensitivity (58B — three layers; final is max)
  sensitivity_tier                TEXT
    CHECK (sensitivity_tier IS NULL OR sensitivity_tier IN ('public','internal','confidential','restricted')),
  sensitivity_evidence            JSONB,                      -- {l1: [...], l2: [...], l3: {tier, reasoning}}

  -- Generic features (58B — L1 + L2)
  generic_features                JSONB,                      -- {pageCount, hasTable, hasSignature, hasHandwriting, layoutType, ...}
  layout_fingerprint              TEXT,                       -- perceptual hash for template detection

  -- Classification (58C)
  module                          TEXT,                       -- 'cert','training','compliance',... — null until classified
  doc_type                        TEXT,                       -- module-specific subtype, e.g. 'certificate.cpr'
  classification_confidence       DOUBLE PRECISION,
  classification_evidence         JSONB,                      -- {model, prompt_version, alternatives: [...]}

  -- Type-specific extracted features (58C strategy output)
  extracted_features              JSONB,
  extraction_confidence           DOUBLE PRECISION,

  -- Subject resolution (58D)
  subject_resolution_confidence   DOUBLE PRECISION,
  subject_resolution_evidence     JSONB,                      -- {hint_match, content_match, conflict, picklist_options}

  -- Routing (58E)
  downstream_workflow_id          TEXT,
  downstream_workflow_type        TEXT,
  downstream_module_record_id     TEXT,                       -- e.g. cert_submissions.id; populated when module returns
  prior_module                    TEXT,                       -- forensic trail across reclassifications (58F)
  prior_doc_type                  TEXT,

  -- Timestamps
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  scanned_at                      TIMESTAMPTZ,
  classified_at                   TIMESTAMPTZ,
  routed_at                       TIMESTAMPTZ,
  archived_at                     TIMESTAMPTZ,
  soft_purged_at                  TIMESTAMPTZ,
  hard_purged_at                  TIMESTAMPTZ,
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT documents_subject_required_post_routing
    CHECK (lifecycle_state NOT IN ('routed','archived') OR subject_employee_id IS NOT NULL),
  CONSTRAINT documents_module_required_post_classification
    CHECK (lifecycle_state NOT IN ('awaiting_subject','awaiting_routing','routed','archived') OR module IS NOT NULL)
);

CREATE INDEX documents_tenant_state_idx ON cip_documents.documents(tenant_id, lifecycle_state);
CREATE INDEX documents_uploader_idx ON cip_documents.documents(tenant_id, uploader_employee_id);
CREATE INDEX documents_subject_idx ON cip_documents.documents(tenant_id, subject_employee_id) WHERE subject_employee_id IS NOT NULL;
CREATE INDEX documents_module_doctype_idx ON cip_documents.documents(tenant_id, module, doc_type) WHERE module IS NOT NULL;
CREATE INDEX documents_sha256_idx ON cip_documents.documents(tenant_id, sha256);
CREATE INDEX documents_layout_fp_idx ON cip_documents.documents(tenant_id, layout_fingerprint) WHERE layout_fingerprint IS NOT NULL;
```

### `cip_documents.document_embeddings`

```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE cip_documents.document_embeddings (
  document_id        UUID PRIMARY KEY REFERENCES cip_documents.documents(id) ON DELETE CASCADE,
  tenant_id          UUID NOT NULL,
  embedding          vector(1024),         -- mistral-embed dim
  embedding_model    TEXT NOT NULL,        -- 'mistral-embed-v1', etc — capture for reproducibility
  computed_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- HNSW DROPPED — same Zen 3 AVX-512 SIGILL issue as slice 44.
-- Sequential scan over <50K rows is sub-ms.
CREATE INDEX document_embeddings_tenant_idx ON cip_documents.document_embeddings(tenant_id);
```

Query shape skeleton (`packages/document-service/src/db/queries/embeddings.ts`,
no callers in 58A but the helper exists so 58B-I can use it):

```typescript
// Cosine similarity nearest-neighbor query — sequential scan within the
// tenant's embedding rows. Sub-ms below ~50K rows; revisit when a tenant
// crosses that threshold.
export async function findSimilarDocuments(
  tx: PgTransaction,
  tenantId: string,
  embedding: number[],
  limit: number,
): Promise<Array<{ documentId: string; similarity: number }>> { /* SELECT 1 - (embedding <=> $1) AS similarity ... LIMIT $limit */ }
```

### `cip_documents.document_routing_map`

Per-tenant configurable map of `(module, doc_type) → (taskQueue,
workflowType)`. Populated by tenant provisioning + admin tools;
queried by 58E's routing activity. Defined in 58A so 58E doesn't
require a schema migration:

```sql
CREATE TABLE cip_documents.document_routing_map (
  tenant_id          UUID NOT NULL,
  module             TEXT NOT NULL,            -- 'cert','training', ...
  doc_type           TEXT NOT NULL,            -- 'certificate.cpr', 'certificate.first_aid', '*' = catchall for module
  task_queue         TEXT NOT NULL,            -- e.g. 'cip-hr-tasks'
  workflow_type      TEXT NOT NULL,            -- e.g. 'CertificationProcessingWorkflow'
  enabled            BOOLEAN NOT NULL DEFAULT true,
  notes              TEXT,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by         UUID,                     -- employee_id; null for seed
  PRIMARY KEY (tenant_id, module, doc_type)
);

CREATE INDEX document_routing_map_tenant_module_idx ON cip_documents.document_routing_map(tenant_id, module, enabled);
```

Resolution order (58E): exact `(module, doc_type)` match first;
fall back to `(module, '*')`; if no match, doc transitions to
`hitl_admin_queue` with `state_reason='no_routing_rule'`.

### `cip_documents.audit_events`

```sql
CREATE TABLE cip_documents.audit_events (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL,
  document_id       UUID NOT NULL,        -- FK omitted — events outlive documents (post-purge forensics)
  actor_employee_id UUID,                 -- null for system actions
  actor_role        TEXT NOT NULL,        -- 'uploader','admin','system','module:cert',...
  event_type        TEXT NOT NULL,
  payload           JSONB,
  occurred_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

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

-- Initial month partition; 58G adds the cron that creates monthly partitions ahead.
CREATE TABLE cip_documents.audit_events_2026_05 PARTITION OF cip_documents.audit_events
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');

CREATE INDEX audit_events_doc_idx ON cip_documents.audit_events(tenant_id, document_id, occurred_at DESC);
CREATE INDEX audit_events_actor_idx ON cip_documents.audit_events(tenant_id, actor_employee_id, occurred_at DESC) WHERE actor_employee_id IS NOT NULL;
```

---

## Lifecycle state machine

### Valid transitions (`packages/document-service/src/lifecycle/states.ts`)

```
quarantined ──► scanning ──► classifying ──► awaiting_subject ──► awaiting_routing ──► routed ──► archived
     │             │              │                  │                    │              │
     │             ▼              ▼                  ▼                    ▼              ▼
     │         scan_failed   hitl_admin_queue   hitl_admin_queue    hitl_admin_queue   (module-driven)
     │                            │                  │                    │
     │                            └──┬───────────────┴────────────────────┘
     │                               ▼
     │                          (admin or uploader resolves; back to classifying|awaiting_subject|awaiting_routing)
     │
     ▼
   failed   (any state with unrecoverable error → terminal)

Any state ──► soft_purged ──► hard_purged   (operator action; 58G adds the cron for time-based hard-purge)
```

### State-based access matrix (encoded in RLS + `access-policy.ts`)

| State | Uploader can read | Subject can read | Module-permitted reader can read | Tenant admin can read | Doc-service admin can read |
|---|---|---|---|---|---|
| `quarantined` | ✓ (own only) | ✗ | ✗ | ✗ | ✓ (audit/forensic only) |
| `scanning` | ✓ | ✗ | ✗ | ✗ | ✓ |
| `scan_failed` | ✓ | ✗ | ✗ | ✗ | ✓ |
| `classifying` | ✓ | ✗ | ✗ | ✗ | ✓ |
| `awaiting_subject` | ✓ | ✗ | ✗ | ✗ | ✓ |
| `awaiting_routing` | ✓ | ✗ | ✗ | ✗ | ✓ |
| `hitl_admin_queue` | ✓ | ✗ | ✗ | ✓ (route/resolve) | ✓ |
| `reclassification_requested` | ✓ | ✗ | ✗ | ✓ (approve/deny) | ✓ |
| `routed` | ✓ | ✓ (if module rules allow) | ✓ | ✗ (modules own ACL now) | ✗ |
| `archived` | ✓ | ✓ (if module rules allow) | ✓ | ✗ | ✗ |
| `soft_purged` | ✗ | ✗ | ✗ | ✓ (`documents.admin.unpurge`) | ✓ |
| `hard_purged` | row exists in audit only — bytes gone | | | | |
| `failed` | ✓ (own only) | ✗ | ✗ | ✓ (`documents.admin.read`) | ✓ |

"Doc-service admin can read" = an actor with the explicit
`documents.admin.read` permission, NOT a tenant admin or
infrastructure admin. This is the seam that prevents the
"doc-service backdoor" HIPAA risk — `documents.admin.read` is
gated on a dedicated permission group and never bundled into
generic admin roles.

---

## RLS policies (`005_rls_policies.sql`)

```sql
ALTER TABLE cip_documents.documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE cip_documents.document_embeddings ENABLE ROW LEVEL SECURITY;
ALTER TABLE cip_documents.audit_events ENABLE ROW LEVEL SECURITY;

-- Tenant isolation (strict — applies to every actor type)
CREATE POLICY documents_tenant_isolation ON cip_documents.documents
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID);

CREATE POLICY document_embeddings_tenant_isolation ON cip_documents.document_embeddings
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID);

CREATE POLICY audit_events_tenant_isolation ON cip_documents.audit_events
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID);

-- State-based read gate.  Layered on top of tenant isolation; both must pass.
CREATE POLICY documents_lifecycle_read ON cip_documents.documents
  FOR SELECT
  USING (
    -- system actor (worker/temporal): unrestricted within tenant
    current_setting('app.actor_role', true) = 'system'

    -- uploader: always sees own (any state except hard_purged)
    OR (uploader_employee_id = current_setting('app.current_employee_id', true)::UUID
        AND lifecycle_state <> 'hard_purged')

    -- doc-service admin: forensic visibility on every state including pre-classified
    OR current_setting('app.has_documents_admin_read', true) = 'true'

    -- subject + module-permitted readers: only post-routing
    OR (lifecycle_state IN ('routed','archived')
        AND (
          subject_employee_id = current_setting('app.current_employee_id', true)::UUID
          OR current_setting('app.has_module_read_for_' || COALESCE(module,'_'), true) = 'true'
        ))

    -- HITL queue: gated on documents.admin.read (admin-routable docs only)
    OR (lifecycle_state = 'hitl_admin_queue'
        AND current_setting('app.has_documents_admin_read', true) = 'true')

    -- soft-purged: documents.admin.unpurge only
    OR (lifecycle_state = 'soft_purged'
        AND current_setting('app.has_documents_admin_unpurge', true) = 'true')
  );
```

Session GUCs are set by `withActorContext()` in
`packages/document-service/src/db/rls.ts` before any query. The
helper takes the actor's resolved `{tenantId, employeeId,
permissions, modulePermissionsByModule}` and emits the full set of
`SET LOCAL app.* = ...` calls below. **Never call the DB without
going through this helper.**

```typescript
// packages/document-service/src/db/rls.ts (skeleton)
type ActorContext = {
  tenantId: string;
  employeeId: string;
  actorRole: 'system' | 'uploader' | 'admin' | 'subject' | 'module' | 'reader';
  hasDocumentsAdminRead: boolean;
  hasDocumentsAdminUnpurge: boolean;
  // Map of module -> bool: did permission catalog grant this actor `${module}.read` ?
  // Populated by checking the actor's permission set against module read codes
  // (e.g. 'cert.read', 'training.read'). Used by RLS policy clause:
  //    app.has_module_read_for_${module} = 'true'
  modulePermissionsByModule: Record<string, boolean>;
};

export async function withActorContext<T>(
  db: NodePgDatabase, actor: ActorContext, fn: (tx: PgTransaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL app.current_tenant_id = ${actor.tenantId}`);
    await tx.execute(sql`SET LOCAL app.current_employee_id = ${actor.employeeId}`);
    await tx.execute(sql`SET LOCAL app.actor_role = ${actor.actorRole}`);
    await tx.execute(sql`SET LOCAL app.has_documents_admin_read = ${String(actor.hasDocumentsAdminRead)}`);
    await tx.execute(sql`SET LOCAL app.has_documents_admin_unpurge = ${String(actor.hasDocumentsAdminUnpurge)}`);
    for (const [mod, has] of Object.entries(actor.modulePermissionsByModule)) {
      // GUC names are sanitised — module strings come from our own catalog, not user input.
      await tx.execute(sql.raw(`SET LOCAL app.has_module_read_for_${mod} = '${has}'`));
    }
    return fn(tx);
  });
}
```

The full GUC list, together:

| GUC | Type | Set by | Read by |
|---|---|---|---|
| `app.current_tenant_id` | UUID | every request | tenant isolation policy |
| `app.current_employee_id` | UUID | every request | uploader/subject self-access |
| `app.actor_role` | text | every request | `system` bypass clause |
| `app.has_documents_admin_read` | bool | every request | HITL queue + forensic clauses |
| `app.has_documents_admin_unpurge` | bool | every request | soft-purged restore clause |
| `app.has_module_read_for_<module>` | bool | per module the actor has perms in | post-routing module gate |

---

## Permission catalog rows

Seeded into `cip_hr.permission_catalog` (the canonical catalog —
not duplicated in `cip_documents`). Migration
`006_seed_permissions.sql` runs on document-service startup:

```sql
-- Real permission_catalog schema is (service, module, permission, description).
-- 'service' is the owning service; for documents.* perms we use 'document-service'.
-- Conflict key is (service, module, permission).
INSERT INTO permission_catalog (service, module, permission, description) VALUES
  ('document-service', 'documents', 'documents.upload',        'Submit a new document for processing'),
  ('document-service', 'documents', 'documents.own.read',      'View documents this user uploaded, in any state'),
  ('document-service', 'documents', 'documents.admin.read',    'Read access to docs awaiting human review (HITL queue, scan failures, etc)'),
  ('document-service', 'documents', 'documents.admin.route',   'Admin tool: assign a stuck document to a downstream module workflow; also covers reclassify approval'),
  ('document-service', 'documents', 'documents.admin.purge',   'Soft-delete a document or trigger immediate hard-purge'),
  ('document-service', 'documents', 'documents.admin.unpurge', 'Restore a soft-purged document to its prior state'),
  ('document-service', 'documents', 'documents.audit.read',    'View the doc-service audit_events for any doc within the tenant'),
  ('document-service', 'documents', 'documents.system.read',   'Service-role only — never granted to humans. Used by Temporal workers.')
ON CONFLICT (service, module, permission) DO UPDATE
  SET description = EXCLUDED.description;
```

`documents.system.read` is by convention service-role-only — the
`provision-tenant` seed must NEVER bundle it into any human-facing
permission group. Service-to-service is the only legitimate caller
and goes through JWT forwarding (the actor's identity, not a
doc-service principal).

**Cross-schema seeding pattern**: the migration runs in
document-service's own DB connection but writes to `permission_catalog`
which lives in the same Postgres but in the default (cip_hr) schema.
The doc-service's DB user needs INSERT/UPDATE on
`permission_catalog`. Bootstrap script grants this; the migration
runner does the seed at doc-service deploy time.

---

## Module-side contract (in `@cip/shared`)

Every module that consumes documents must implement two activities,
registered with its own Temporal worker, that the doc-service
routing workflow (58E) calls into:

```typescript
// packages/shared/src/types/document-module-contract.ts

import { z } from 'zod';

export const ProcessDocumentInputSchema = z.object({
  tenantId: z.string().uuid(),
  documentId: z.string().uuid(),
  uploaderEmployeeId: z.string().uuid(),
  subjectEmployeeId: z.string().uuid(),         // resolved by 58D before this is called
  docType: z.string(),                          // module-specific subtype
  extractedFeatures: z.record(z.unknown()),     // L3 features from doc-service
  genericFeatures: z.record(z.unknown()),       // L1 features (pageCount, hasTable, ...)
  sensitivityTier: z.enum(['public','internal','confidential','restricted']),
  s3Bucket: z.string(),
  s3Key: z.string(),                            // module fetches via presigned URL if it needs bytes
});
export type ProcessDocumentInput = z.infer<typeof ProcessDocumentInputSchema>;

export const ProcessDocumentOutputSchema = z.object({
  moduleRecordId: z.string(),                   // e.g. cert_submissions.id
  status: z.enum(['accepted','needs_hitl','rejected']),
  rejectionReason: z.string().optional(),
});
export type ProcessDocumentOutput = z.infer<typeof ProcessDocumentOutputSchema>;

export const RevokeForInputSchema = z.object({
  tenantId: z.string().uuid(),
  documentId: z.string().uuid(),
  moduleRecordId: z.string(),
  reason: z.enum(['reclassification','manual_admin_revoke','soft_purge','hard_purge']),
  requestedByEmployeeId: z.string().uuid(),
});
export type RevokeForInput = z.infer<typeof RevokeForInputSchema>;

export const RevokeForOutputSchema = z.object({
  success: z.boolean(),
  revokedAt: z.string().datetime(),
  compensatingActions: z.array(z.string()),     // e.g. ['cert_submission.deleted','cert_definition.unmatched']
});
export type RevokeForOutput = z.infer<typeof RevokeForOutputSchema>;
```

58E (cert migration) implements both activities for the cert
module. Future module consumers do the same. The doc-service
routing workflow proxies these via Temporal task queues —
`cip-hr-tasks` for cert/employee modules, future modules add their
own queues.

---

## ClamAV chart (`infra/k8s/clamav/`)

### `values.yaml` (operator-tunable)

```yaml
image:
  repository: clamav/clamav
  tag: "1.4"                  # NEVER :latest — Cisco Talos rolls breaking config between minors
  pullPolicy: IfNotPresent

resources:
  requests:
    cpu: "1"
    memory: "1.5Gi"
  limits:
    memory: "2Gi"

clamd:
  maxFileSize: 25M
  maxScanSize: 50M
  maxRecursion: 8
  maxFiles: 1000
  streamMaxLength: 25M
  concurrentDatabaseReload: true

freshclam:
  checkIntervalHours: 1       # Cisco rate-limits if you hammer it; hourly is the public-mirror norm

probes:
  startupGraceSeconds: 60     # signature DB load is slow; don't kill the pod during cold start
  livenessFailureThreshold: 5
```

### `templates/configmap-clamd-conf.yaml`

`clamd.conf` is rendered from values; key entries:

```
TCPSocket 3310
TCPAddr 0.0.0.0
MaxFileSize {{ .Values.clamd.maxFileSize }}
MaxScanSize {{ .Values.clamd.maxScanSize }}
MaxRecursion {{ .Values.clamd.maxRecursion }}
MaxFiles {{ .Values.clamd.maxFiles }}
StreamMaxLength {{ .Values.clamd.streamMaxLength }}
ConcurrentDatabaseReload {{ .Values.clamd.concurrentDatabaseReload }}
LogTime yes
LogClean no                    # successful scans aren't noteworthy
```

### Demo-mode resource sizing (default)

The chart ships with **demo-mode defaults** (`750Mi requests / 1Gi
limit`, ~50% of full mode). Trade-offs:

- `DetectPUA no` saves ~250MB (loses adware/grayware signatures)
- `Bytecode no` saves ~50MB (loses bytecode-pattern engine)

These trims are baked into `values.yaml` + `configmap-clamd-conf.yaml`
templating. EICAR detection + standard real-world malware sigs are
preserved (~90-95% detection rate vs full mode).

**Production override** when running on a multi-node cluster:

```bash
helm upgrade clamav infra/k8s/clamav \
  --set resources.requests.memory=1.5Gi \
  --set resources.limits.memory=2Gi \
  --set resources.requests.cpu=1 \
  --set clamd.detectPUA=true \
  --set clamd.bytecodeSignatures=true \
  --set freshclam.checkIntervalHours=1
```

The values.yaml header documents this in detail; future operators
seeing demo-mode running in prod should restore via the recipe
above.

### `templates/networkpolicy.yaml`

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: clamav-allow-document-service
  namespace: cip-infra
spec:
  podSelector:
    matchLabels: { app: clamav }
  policyTypes: [Ingress]
  ingress:
  - from:
    - namespaceSelector:
        matchLabels: { name: cip-app }
      podSelector:
        matchLabels: { app: document-service }
    ports: [{ protocol: TCP, port: 3310 }]
```

### Liveness/readiness via PING/PONG over TCP

```yaml
readinessProbe:
  exec:
    command: [/bin/sh, -c, 'echo PING | nc -w 2 localhost 3310 | grep -q PONG']
  initialDelaySeconds: 60
  periodSeconds: 15
  failureThreshold: 3

livenessProbe:
  exec:
    command: [/bin/sh, -c, 'echo PING | nc -w 2 localhost 3310 | grep -q PONG']
  initialDelaySeconds: 120
  periodSeconds: 60
  failureThreshold: 5
```

---

## EICAR test path

`packages/document-service/test/av-integration.test.ts` runs the
EICAR test pattern against the dev clamd. This is the
industry-standard fake "virus" — 68 ASCII bytes that every AV
engine agrees should trigger detection. Proves the wiring without
shipping real malware.

```typescript
const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

test('clamd detects EICAR pattern', async () => {
  const client = new ClamAVClient({ host: 'clamav.cip-infra', port: 3310 });
  const result = await client.scanBuffer(Buffer.from(EICAR));
  expect(result.clean).toBe(false);
  expect(result.threat).toMatch(/EICAR/);
});

test('clamd marks legitimate text as clean', async () => {
  const client = new ClamAVClient({ host: 'clamav.cip-infra', port: 3310 });
  const result = await client.scanBuffer(Buffer.from('hello world'));
  expect(result.clean).toBe(true);
});
```

Test runs in CI against a local clamd (docker-compose) and against
the dev cluster's clamav as a smoke check.

---

## Acceptance criteria

A 58A session is complete when ALL of these are true:

1. `pnpm --filter @cip/document-service typecheck` passes.
2. `pnpm --filter @cip/document-service test` passes (lifecycle +
   access-policy unit tests; av-integration test SKIPPED if no
   clamd reachable, not failed).
3. `pnpm --filter @cip/document-service build` produces a deployable
   image.
4. `helm upgrade --install clamav ./infra/k8s/clamav` deploys cleanly
   to the dev cluster; `kubectl exec` into the pod and run
   `freshclam --version` shows a non-stale signature DB.
5. `helm upgrade --install document-service ./packages/document-service/helm`
   deploys; pod reaches Ready; `/healthz` returns 200.
6. Migrations 001-006 apply cleanly; `\d cip_documents.documents`
   shows every column listed above.
7. RLS policies block cross-tenant reads — verified by setting
   `app.current_tenant_id` to a different UUID and confirming
   SELECT returns 0 rows.
8. RLS state-gate works — quarantined doc inserted under tenant T1
   is invisible to a non-uploader actor in T1 even with
   `documents.admin.read` is_false.
9. EICAR integration test passes against the dev cluster's clamav.
10. `cip_hr.permission_catalog` contains the eight `documents.*`
    rows (visible via existing `permission_holders` admin tool).
11. The slice does NOT introduce any code path that reads, writes,
    or processes a document. (58B+ does that.)
12. `slices/CONTEXT_WORKFLOW.md` updated with 58A entry marked
    PENDING and 58B-I listed as DRAFTED.

---

## Forward references (named, not implemented in 58A)

| Slice | Scope | New schema in that slice |
|---|---|---|
| **58B** | Bot wiring (capture hint, multi-MCP-server config so bot can call doc-service alongside hr-service, replace cert fast-path with `document_process` on doc-service); `DocumentProcessingWorkflow` scaffold; `scanForVirusesActivity` (clamav via INSTREAM); L1+L2 feature extraction; sensitivity scoring (L1+L2+L3); **bot-progress-channel** (NATS-backed proactive Teams messaging from activities — new sub-component since cert flow today is fire-and-forget) | none — uses 58A schema |
| **58C** | Classification activity (LLM, Langfuse-hosted prompt, threshold tunable, takes L1+L2 features); extraction-strategy interface in `@cip/shared`; cert-strategy implementation delegates to existing `runVisionAgentActivity` | none |
| **58D** | Subject resolution: hint parser + content NER + uploader/content conflict + HITL pick-list cards; admin HITL queue MCP tools (`documents_hitl_*`) | none |
| **58E** | Routing handoff: queries `document_routing_map`; cert workflow rewritten as Route-A consumer (`processDocument` + `revokeFor` activities in cert module replace fetch+preClassify+vision); legacy `process_document` MCP tool removed | seeds default `document_routing_map` rows for `(cert, *) → (cip-hr-tasks, CertificationProcessingWorkflow)` |
| **58F** | Reclassification: uploader-initiated reclassify card; admin approval workflow for `routed`/`archived` reclassifications; uses `pre_hitl_state` + audit `reclassification_*` events | none |
| **58G** | Soft-delete + configurable hard-purge: monthly partition cron for audit_events; per-tenant `documents.hard_purge_after_days` tunable; Temporal workflow walks soft-purged rows past threshold; uses `pre_purge_state` for restore | none |
| **58H** | Per-tenant doc-type classifier (replaces 58C LLM classifier as corpus grows): nightly Temporal `RetrainDocClassifierWorkflow` mirrors slice 56N | new tables `document_classifier_runs`, `document_classifier_training_data`, both in `cip_documents` |
| **58I** | Cert template-and-compare (cert-module-specific): canonical-template definitions, `compareToTemplate(documentId, templateId)` activity, template-similarity HITL UX | new tables `document_templates` (in `cip_documents`) and `cert_template_field_definitions` (in `cip_hr`) |

---

## Cross-slice notes

Module-side contract changes in `@cip/shared` — every consumer of
`@cip/shared` types should typecheck after this slice merges.
Expected to touch:

- `@cip/hr-service` — new `ProcessDocumentInput` import once 58E lands
- `@cip/teams-bot` — no immediate impact; 58B wires it

If any package fails to typecheck on `pnpm -r run typecheck` after
58A merges and the failure ISN'T in `@cip/shared` or
`@cip/document-service`, log a CROSS-SLICE NOTE and resolve before
58B starts.

---

## Implementation note — version reality vs version research

The "Library versions" table below is what the version-research
agent found as latest-stable. The actual implementation uses
**workspace-current versions** to avoid mixing two major versions
of the same lib in one workspace:

| Lib | Slice-doc target | Implementation reality | Why |
|---|---|---|---|
| TypeScript | 5.9.x | 5.4.x | Match existing workspace |
| drizzle-orm | 1.0.0-rc.1 | 0.41.x | Match existing |
| zod | 4.x | 3.23.x | v3→v4 is invasive; defer to workspace upgrade |
| express | 5.2.x | 4.19.x | path-to-regexp@8 breaking; defer |
| @modelcontextprotocol/sdk | 1.29.x | 1.0.x | Standard-Schema breaking; defer |
| @langchain/core | 1.1.44 | 1.1.x ✓ | Aligned |
| @temporalio/* | 1.17.0 | 1.17.0 ✓ | Aligned |
| pg | 8.20.x | 8.11.x | Within minor; either is fine |
| @aws-sdk/client-s3 | 3.1041.x | 3.600.x | Within minor; either is fine |
| pdfjs-dist (NEW dep) | 5.7.284 | 5.7.x | New for this slice |
| sharp (NEW dep) | 0.34.5 | 0.34.x | New for this slice |
| clamscan (NEW dep) | 2.4.0 | 2.4.0 ✓ | New for this slice |
| @langfuse/langchain | v5 | 5.0.x ✓ | Match existing |

The slice-doc target versions are the **target state for a separate
workspace-wide upgrade slice** (not 58A, not 58B-G). When that
slice happens, ALL packages move together.

## Permission catalog column names

Slice doc originally proposed `(module, code, label, description,
is_system)`. The real `cip_hr.permission_catalog` schema is
`(service, module, permission, description)`. The implementation
uses the real schema — this section's "Permission catalog rows"
SQL is updated to match below.

## Library versions (canonical for the entire 58 family)

Pinned at slice-58A start; subsequent slices in the family inherit
unless a specific upgrade is required and called out.

### Runtime + tooling

| Library | Version | Notes |
|---|---|---|
| Node.js | 22 LTS | Active LTS until 2027-04-30 |
| pnpm | 10.33.x | **pnpm 9 EOL'd 2026-04-30 — must move off 9** before this slice |
| TypeScript | 5.9.x | Stay on 5.9 (or 6.0); TS 7 Go-rewrite still beta |
| Vitest | 4.1.x | v3→v4 had config tightening; keep test config minimal |

### Server / framework

| Library | Version | Trap |
|---|---|---|
| express | 5.2.1 | v5: async middleware errors auto-caught; `path-to-regexp@8` rejects sub-expression regex — audit any `:param(regex)` patterns |
| @modelcontextprotocol/sdk | 1.29.x | **Tool schemas now Standard-Schema (Zod 4)**; use `registerTool()`, not the legacy 5-arg `server.tool(...)` |
| zod | 4.x | **`z.string().email()` → `z.email()`**, etc. `z.function()` no longer a schema. Object defaults apply through `.optional()` |
| pino | 10.3.x | No major API changes |

### Temporal

| Library | Version |
|---|---|
| @temporalio/worker, /client, /workflow | 1.17.0 |

### Database

| Library | Version | Trap |
|---|---|---|
| drizzle-orm | **1.0.0-rc.1** | v1 reworked casing (per-table import from `drizzle-orm/dialect-core`); pg array utils relocated to `pg-core/array`; **drizzle-zod is now bundled — drop the separate dep** |
| drizzle-kit | 1.0.0-beta.x | Track drizzle-orm v1 line |
| pg (node-postgres) | 8.20.x | No v9 yet |
| pgvector (Postgres ext) | 0.8.2 | Adds halfvec/sparsevec; we still use plain `vector` |
| pgvector (npm) | 0.2.1 | Quiet but functional |

### LLM / embeddings / orchestration

| Library | Version | Trap |
|---|---|---|
| @langchain/core | 1.1.44 | Single-instance peer dep |
| @langchain/langgraph | 1.2.9 | Stable v1 |
| langchain (TS) | 1.3.5 | v1 GA |
| @langchain/openai | matches core ^1.x | Pin |
| **@mistralai/mistralai** | 2.2.1 | **ESM-only**; type names shortened (`ChatCompletionResponse` → `ChatResponse`); requires Zod 4 |
| LiteLLM (Python proxy) | 1.83.14-stable | Deployed service, no client lib |

### OTEL / Langfuse

| Library | Version | Trap |
|---|---|---|
| @opentelemetry/sdk-node | **0.216.0 — pin exactly** | Pre-1.0; minor bumps break instrumentation |
| @opentelemetry/auto-instrumentations-node | matches sdk-node | Same cadence |
| @opentelemetry/exporter-trace-otlp-http | matches sdk-node | Same |
| **@langfuse/langchain** (NOT `langfuse-langchain`) | v5.x modular | `langfuse` + `langfuse-langchain` are deprecated; migrate to modular `@langfuse/*` packages on OTel JS v2 |

### AWS

| Library | Version |
|---|---|
| @aws-sdk/client-s3 | 3.1041.x |
| @aws-sdk/s3-request-presigner | 3.1041.x (matched) |

### Teams Bot

| Library | Version |
|---|---|
| @microsoft/agents-hosting | 1.3.1 |
| @microsoft/agents-activity | 1.3.x (matched) |
| adaptivecards | 3.0.6 |

### Image / file / OCR

| Library | Version | Trap |
|---|---|---|
| sharp | 0.34.5 | Requires Node ^18.17 / ≥20.3 |
| pdfjs-dist | 5.7.284 | **Preferred over pdf-parse** — actively maintained, ~9.7M weekly DLs |
| file-type | 22.0.1 | **ESM-only** since v17 |

### ClamAV

| Library | Version | Trap |
|---|---|---|
| clamav/clamav (Docker) | `1.4` (or `stable_base`) | Cisco-Talos official; never `:latest` |
| clamscan (npm) | 2.4.0 | **Marked Inactive** — no release in >12 months. Fine for now (CVEs unlikely on a TCP-protocol-translation lib), budget for fork-or-replace if a CVE lands. Pin the version. |

### Python (intent-classifier; carries forward, no upgrades in this slice)

| Library | Version |
|---|---|
| scikit-learn | 1.8.0 |
| joblib | 1.5.3 |
| FastAPI | 0.136.1 |
| uvicorn | bundled via `fastapi[standard]` |

---

## Operator runbook (additions for 58A)

Save to `slices/SLICE_58_OPERATOR_RUNBOOK.md` (new file, grows over
the 58 family):

- **ClamAV signature DB stale alert**: signature_db_age > 24h →
  `kubectl logs -n cip-infra deploy/clamav -c freshclam` shows the
  upstream rate-limit response. Wait 4-6h for the IP to clear; if
  persistent, check whether multiple replicas are hammering the same
  source IP.
- **Quarantined doc invisible to expected reader**: confirm
  `app.current_employee_id` GUC is being set by `withActorContext`;
  RLS state-gate denies reads when GUCs are unset.
- **Pod restart drops in-flight scans**: ClamAV is stateless across
  restarts; the corresponding Temporal activity retries — no manual
  recovery needed.
- **Manual hard-purge** (operator action; 58G adds the cron):
  `kubectl exec` into hr-service, run `psql` against `cip_documents`,
  `UPDATE documents SET lifecycle_state='hard_purged', hard_purged_at=NOW() WHERE id=…;`
  then aws-cli `s3 rm` the object. Audit row must be inserted in
  the same transaction.
