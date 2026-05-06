-- Slice 58E — seed documents.admin.routing_map.* permissions for the
-- new routing-map admin MCP tools. Same shape + conflict key as 007.
--
-- Slice 68 update: permission_catalog moved to cip_platform schema. Write
-- to the new home directly. Same Postgres instance; cross-schema requires
-- the doc-service DB user have INSERT/UPDATE on cip_platform.permission_catalog
-- (granted by initTenantDatabase activity / operator).

INSERT INTO cip_platform.permission_catalog (service, module, permission, description) VALUES
  ('document-service', 'documents', 'documents.admin.routing_map.read',
   'List the (module, doc_type) → workflow routing rules for the tenant.'),
  ('document-service', 'documents', 'documents.admin.routing_map.write',
   'Insert or update a (module, doc_type) routing rule for the tenant.')
ON CONFLICT (service, module, permission) DO UPDATE
  SET description = EXCLUDED.description;
