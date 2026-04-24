-- ─────────────────────────────────────────────────────────────────────────────
-- CIP HR Domain — Initial Schema
-- All tables include tenant_id as the first column.
-- Row-Level Security is enabled on all tables.
-- tenant_id is NEVER nullable.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "vector";

-- Set the RLS context variable — call this at the start of every DB session
-- SET app.current_tenant_id = '<tenantId>';

-- ── Workers ──────────────────────────────────────────────────────────────────
CREATE TABLE workers (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id    UUID NOT NULL,
  email        TEXT NOT NULL,
  full_name    TEXT NOT NULL,
  keycloak_id  TEXT NOT NULL UNIQUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE workers ENABLE ROW LEVEL SECURITY;
CREATE POLICY workers_tenant_isolation ON workers
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID);

-- ── Certifications ────────────────────────────────────────────────────────────
CREATE TABLE certifications (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id         UUID NOT NULL,
  worker_id         UUID NOT NULL REFERENCES workers(id),
  cert_type         TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','processing','validated','expired','rejected','hitl_review')),
  expires_at        TIMESTAMPTZ,
  extracted_fields  JSONB,
  confidence        NUMERIC(4,3),
  object_store_key  TEXT NOT NULL,
  prompt_version    TEXT,
  model_used        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE certifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY certifications_tenant_isolation ON certifications
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID);

CREATE INDEX idx_certifications_tenant_worker ON certifications(tenant_id, worker_id);
CREATE INDEX idx_certifications_expires_at ON certifications(expires_at) WHERE status = 'validated';

-- ── Outcome Store — AI calibration data ──────────────────────────────────────
CREATE TABLE agent_runs (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id         UUID NOT NULL,
  domain            TEXT NOT NULL,
  agent_type        TEXT NOT NULL,
  workflow_id       TEXT NOT NULL,
  activity_id       TEXT NOT NULL,
  prompt_version    TEXT,
  model_used        TEXT,
  memory_context_id UUID,
  input_hash        TEXT,
  ran_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at       TIMESTAMPTZ  -- NULL until ground truth arrives
);

ALTER TABLE agent_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY agent_runs_tenant_isolation ON agent_runs
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID);

CREATE TABLE field_outcomes (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agent_run_id         UUID NOT NULL REFERENCES agent_runs(id),
  tenant_id            UUID NOT NULL,
  entity_type          TEXT NOT NULL,
  entity_id            UUID NOT NULL,
  field_name           TEXT NOT NULL,
  agent_value          TEXT,
  agent_confidence     NUMERIC(4,3),
  ground_truth_value   TEXT,
  ground_truth_source  TEXT CHECK (ground_truth_source IN ('human_hitl','validation_rule','downstream_outcome')),
  was_correct          BOOLEAN,
  correction_delta     TEXT,
  corrected_by         UUID,
  recorded_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE field_outcomes ENABLE ROW LEVEL SECURITY;
CREATE POLICY field_outcomes_tenant_isolation ON field_outcomes
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID);

CREATE TABLE memory_writes (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id      UUID NOT NULL,
  agent_run_id   UUID NOT NULL REFERENCES agent_runs(id),
  vector_store_id TEXT NOT NULL,
  memory_type    TEXT NOT NULL,
  scope          TEXT NOT NULL CHECK (scope IN ('provider','cert_type','worker','tenant')),
  scope_id       TEXT NOT NULL,
  content_hash   TEXT NOT NULL,
  expires_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE memory_writes ENABLE ROW LEVEL SECURITY;
CREATE POLICY memory_writes_tenant_isolation ON memory_writes
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID);

-- ── Vector Store (pgvector) ───────────────────────────────────────────────────
CREATE TABLE agent_memory_vectors (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id   UUID NOT NULL,
  scope       TEXT NOT NULL,
  scope_id    TEXT NOT NULL,
  memory_type TEXT NOT NULL,
  content     TEXT NOT NULL,
  embedding   vector(1536),  -- OpenAI/Anthropic embedding dimension
  metadata    JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ
);

ALTER TABLE agent_memory_vectors ENABLE ROW LEVEL SECURITY;
CREATE POLICY agent_memory_vectors_tenant_isolation ON agent_memory_vectors
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID);

-- Create HNSW index from day one — prevents painful migration later
CREATE INDEX idx_agent_memory_vectors_embedding ON agent_memory_vectors
  USING hnsw (embedding vector_cosine_ops);
