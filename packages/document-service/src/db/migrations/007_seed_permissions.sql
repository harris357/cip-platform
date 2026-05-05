-- Slice 58A — seed documents.* permissions into the canonical
-- permission_catalog table (lives in the default cip_hr schema;
-- the doc-service DB user has INSERT/UPDATE granted).
--
-- Real schema: (service, module, permission, description).  Conflict
-- key is (service, module, permission).  documents.system.read is
-- never bundled into a human-facing permission group by convention.

INSERT INTO permission_catalog (service, module, permission, description) VALUES
  ('document-service', 'documents', 'documents.upload',        'Submit a new document for processing'),
  ('document-service', 'documents', 'documents.own.read',      'View documents this user uploaded, in any state'),
  ('document-service', 'documents', 'documents.admin.read',    'Read access to docs awaiting human review (HITL queue, scan failures, reclassification queue)'),
  ('document-service', 'documents', 'documents.admin.route',   'Manually route a stuck doc to a downstream module workflow; also covers reclassify approval'),
  ('document-service', 'documents', 'documents.admin.purge',   'Soft-delete a document or trigger immediate hard-purge'),
  ('document-service', 'documents', 'documents.admin.unpurge', 'Restore a soft-purged document to its prior state'),
  ('document-service', 'documents', 'documents.audit.read',    'View the doc-service audit_events for any doc within the tenant'),
  ('document-service', 'documents', 'documents.system.read',   'Service-role only — never granted to humans. Used by Temporal workers.')
ON CONFLICT (service, module, permission) DO UPDATE
  SET description = EXCLUDED.description;
