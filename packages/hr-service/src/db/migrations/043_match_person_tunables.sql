-- Slice 58D-A — MatchPersonWorkflow tunables.
--
-- Read once at workflow entry (not per-activity) per the matcher's
-- deterministic-replay guarantees. Mid-flight tunable changes are not
-- honoured until the next workflow run.
--
-- Tenants override platform defaults by inserting their own row with
-- the real tenant_id. Zero-UUID is the platform default catchall.

INSERT INTO bot_tunables (tenant_id, key, value_json, notes) VALUES
  ('00000000-0000-0000-0000-000000000000', 'hr.person_match_auto_threshold',     '0.9',
   'Single-match auto-resolve threshold; >= this score and exactly one candidate -> source=auto_unique. Below -> HITL pickcard.'),
  ('00000000-0000-0000-0000-000000000000', 'hr.person_match_uploader_ttl_hours', '24',
   'Wait this long for the uploader pickcard click before cascading to the admin queue.'),
  ('00000000-0000-0000-0000-000000000000', 'hr.person_match_admin_ttl_hours',    '168',
   'Admin queue TTL (default 7 days). On expiry the matcher returns outcome=no_resolution with reason=hitl_ttl_exhausted.'),
  ('00000000-0000-0000-0000-000000000000', 'hr.person_match_shortlist_max',      '5',
   'Max candidates returned by the pg_trgm shortlist activity. Higher gives the LLM canonicalizer more to pick from but slows the workflow.'),
  ('00000000-0000-0000-0000-000000000000', 'hr.person_match_canonicalize_model', '"cip-classifier"',
   'LiteLLM alias for the canonicalization step (resolved via the alias-resolver / routing_rules layer at activity entry).')
ON CONFLICT (tenant_id, key) DO NOTHING;
