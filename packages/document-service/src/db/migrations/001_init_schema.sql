-- Slice 58A — initialize cip_documents schema
--
-- Lives in the same Postgres instance as cip_hr; isolated to its own
-- schema so a future extraction of @cip/document-service to its own
-- DB is a config change, not a data move.

CREATE SCHEMA IF NOT EXISTS cip_documents;

-- Extensions are created by bootstrap.sh as superuser before this runs.
-- We rely on pgvector for the document_embeddings table (004) and on
-- gen_random_uuid() (pgcrypto, present in default installs since PG13).
