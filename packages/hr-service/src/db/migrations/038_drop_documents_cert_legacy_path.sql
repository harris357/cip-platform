-- Slice 58B-2b cleanup: drop the now-obsolete `documents.cert_legacy_path`
-- tunable.  The bot's dual-path branching was retired once the new
-- doc-service-routed upload was verified live.  hr-service still hosts
-- the legacy `process_document` MCP tool — slice 58E removes it as part
-- of the cert workflow rewrite into a Route-A consumer of the new
-- ProcessDocumentInput contract.

DELETE FROM bot_tunables
 WHERE key = 'documents.cert_legacy_path';
