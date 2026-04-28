-- Creates the migration tracking table.
-- Safe to run multiple times (IF NOT EXISTS).
CREATE TABLE IF NOT EXISTS schema_migrations (
  migration   TEXT        PRIMARY KEY,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
