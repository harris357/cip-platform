-- Slice 58A — document embeddings (pgvector)
--
-- One row per doc (1024-d mistral-embed). HNSW index intentionally
-- dropped — same Zen 3 AVX-512 SIGILL as slice 44. Sequential scan
-- over <50K rows per tenant is sub-ms; revisit when a tenant
-- crosses that threshold.
--
-- Cascades on doc delete so hard-purge (58G) cleans up automatically.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE cip_documents.document_embeddings (
  document_id        UUID PRIMARY KEY REFERENCES cip_documents.documents(id) ON DELETE CASCADE,
  tenant_id          UUID NOT NULL,
  embedding          vector(1024),
  embedding_model    TEXT NOT NULL,                  -- e.g. 'mistral-embed-v1' — capture for reproducibility
  computed_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX document_embeddings_tenant_idx ON cip_documents.document_embeddings(tenant_id);
