-- Slice 42A: registry of every known permission code.
-- Resolver expands glob entries (cert.* → all cert permissions) by
-- joining against this catalog. Operators read it for audit.
--
-- Source of truth: hr-service's startup seed (services/permission-catalog-seed.ts).
-- DB is read-by-runtime, written-by-startup. Idempotent ON CONFLICT.

CREATE TABLE IF NOT EXISTS permission_catalog (
  service     TEXT NOT NULL,                -- 'hr-service'
  module      TEXT NOT NULL,                -- 'cert' | 'employee' | 'compliance' | 'tenant'
  permission  TEXT NOT NULL,                -- 'cert.submit'
  description TEXT,
  PRIMARY KEY (service, module, permission)
);

CREATE INDEX IF NOT EXISTS permission_catalog_module_idx
  ON permission_catalog (service, module);
