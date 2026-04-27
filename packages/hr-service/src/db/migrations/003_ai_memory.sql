-- ============================================================
-- CIP HR — AI Calibration & Vector Memory Tables
-- Depends on: 002_domain_model.sql (agent_runs table)
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "vector";

-- ============================================================
-- FIELD OUTCOMES (agent calibration data)
-- ============================================================

CREATE TABLE IF NOT EXISTS field_outcomes (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            UUID NOT NULL,
  agent_run_id         UUID NOT NULL REFERENCES agent_runs(id),
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
CREATE POLICY tenant_isolation ON field_outcomes
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID);

-- ============================================================
-- MEMORY WRITES (tracks what was written to vector store)
-- ============================================================

CREATE TABLE IF NOT EXISTS memory_writes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL,
  agent_run_id    UUID NOT NULL REFERENCES agent_runs(id),
  vector_store_id TEXT NOT NULL,
  memory_type     TEXT NOT NULL,
  scope           TEXT NOT NULL CHECK (scope IN ('provider','cert_type','worker','tenant')),
  scope_id        TEXT NOT NULL,
  content_hash    TEXT NOT NULL,
  expires_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE memory_writes ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON memory_writes
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID);

-- ============================================================
-- AGENT MEMORY VECTORS (pgvector)
-- ============================================================

CREATE TABLE IF NOT EXISTS agent_memory_vectors (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL,
  scope       TEXT NOT NULL,
  scope_id    TEXT NOT NULL,
  memory_type TEXT NOT NULL,
  content     TEXT NOT NULL,
  embedding   vector(1536),
  metadata    JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ
);

ALTER TABLE agent_memory_vectors ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agent_memory_vectors
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID);

-- HNSW index for cosine similarity search
CREATE INDEX idx_agent_memory_vectors_embedding ON agent_memory_vectors
  USING hnsw (embedding vector_cosine_ops);
