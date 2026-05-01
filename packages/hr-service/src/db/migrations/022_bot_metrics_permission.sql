-- Slice 46e: bot.metrics.read permission for the new admin MCP tools
-- (bot_metrics_get_turn / _summary / _top_n / _tools / _outliers) and
-- the /turn slash command.
--
-- Slice 48 follow-up: seed the lg.session_timeout_minutes tunable
-- so ingest can delineate Langfuse sessions inside a thread.

-- Permission catalog entry
INSERT INTO permission_catalog (service, module, permission, description) VALUES
  ('hr-service', 'platform', 'bot.metrics.read',
   'Read access to bot_turn_metrics — required for /turn, /metrics, and the bot_metrics_* admin MCP tools.')
ON CONFLICT (service, module, permission) DO NOTHING;

-- Add to a permission group. We model this as a per-tenant
-- 'admin__platform' group, mirroring the admin__* pattern used for
-- cert/employee/compliance/tenant. For each tenant that has a
-- 'hr-service-admin' role, ensure such a group exists with the
-- bot.metrics.read permission, and link it.
INSERT INTO permission_groups (tenant_id, code, label, description, service, module, permissions, is_system_role)
SELECT DISTINCT
  r.tenant_id,
  'admin__platform',
  'Admin (platform module)',
  'Platform-scoped admin permissions: bot metrics + future cross-cutting concerns.',
  'hr-service',
  'platform',
  '["bot.metrics.read"]'::jsonb,
  true
FROM roles r
WHERE r.code = 'hr-service-admin'
ON CONFLICT (tenant_id, service, module, code) DO UPDATE
  SET permissions = permission_groups.permissions || EXCLUDED.permissions,
      label       = EXCLUDED.label;

-- Link the platform admin group to the hr-service-admin role.
INSERT INTO role_groups (role_id, group_id)
SELECT r.id, pg.id
  FROM roles r
  JOIN permission_groups pg
    ON pg.tenant_id = r.tenant_id
   AND pg.code = 'admin__platform'
 WHERE r.code = 'hr-service-admin'
ON CONFLICT (role_id, group_id) DO NOTHING;

-- Slice 48 follow-up tunable for session delineation in Langfuse.
INSERT INTO bot_tunables (tenant_id, key, value_json, notes) VALUES
  ('00000000-0000-0000-0000-000000000000', 'lg.session_timeout_minutes', '60',
   'Idle minutes between turns before ingest mints a new Langfuse session. Default 60 — bigger than a coffee break, smaller than a workday.')
ON CONFLICT (tenant_id, key) DO NOTHING;
