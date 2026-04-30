-- Slice 35 follow-up: decouple tenants.id from KC realm name.
--
-- The architectural intent (one identifier == realm name == tenant id) is
-- preserved in production by defaulting realm to id::text. But for dev
-- environments, where one shared realm (cip-dev) serves the test tenant,
-- the realm column lets us insert a tenant row with a UUID id while
-- pointing it at the existing realm name.
--
-- Defaulting to id::text means existing rows (none yet — fresh table) and
-- all newly-inserted rows that don't specify realm explicitly stay aligned
-- with the original architecture.

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS realm TEXT;

UPDATE tenants SET realm = id::text WHERE realm IS NULL;

ALTER TABLE tenants
  ALTER COLUMN realm SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_realm ON tenants(realm);
