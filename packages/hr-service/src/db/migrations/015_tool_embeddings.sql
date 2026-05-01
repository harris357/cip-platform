-- Slice 44: per-tool embeddings for vector-retrieval pre-filter.
--
-- Stores one vector per registered MCP tool (name + description +
-- param schema). The hr-service indexer (services/tool-embeddings-seed.ts)
-- runs on startup and refreshes only when the description_hash differs.
-- The bot's discoverTools queries this table to narrow the candidate set
-- (top-K) before the router LLM sees the catalog.
--
-- INTENTIONALLY GLOBAL (no tenant_id, no RLS). Tools are defined by
-- service code, not data — every tenant sees the same tool catalog
-- (subject to per-user permission filtering, which happens upstream
-- from this table). Permission filtering remains authoritative.
--
-- Pattern lifted from agent_memory_vectors (003_ai_memory.sql) — same
-- HNSW cosine index, different dim (1024 for mistral-embed vs 1536 for
-- OpenAI ada-002 used by agent_memory).

CREATE TABLE IF NOT EXISTS tool_embeddings (
  service           TEXT          NOT NULL,
  tool_name         TEXT          NOT NULL,
  description_hash  TEXT          NOT NULL,
  embedding         vector(1024)  NOT NULL,
  embedded_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  PRIMARY KEY (service, tool_name)
);

CREATE INDEX IF NOT EXISTS idx_tool_embeddings_cosine
  ON tool_embeddings USING hnsw (embedding vector_cosine_ops);

-- Slice 44: register the cip-embed alias for the bot's retrieval step.
-- mistral-embed is 1024-dim and Mistral-policy compliant. Tenants can
-- override via tenant_settings.routing_overrides if they need a different
-- embedding model (must match dim=1024).
INSERT INTO routing_rules (service, purpose, alias, notes) VALUES
  ('bot', 'embed', 'mistral-embed',
   'Embeds the user message and tool descriptions for top-K vector retrieval (Slice 44). 1024-dim.')
ON CONFLICT (service, purpose) DO UPDATE
  SET alias      = EXCLUDED.alias,
      notes      = EXCLUDED.notes,
      updated_at = NOW(),
      updated_by = 'migration-015';
