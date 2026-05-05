-- Slice 58B: seed documents.* tunables in bot_tunables.
--
-- Tunables read by @cip/document-service activities; reads merged with
-- per-tenant overrides via the same shadow pattern as the bot's lg.*
-- tunables (zero-UUID sentinel + per-tenant rows). See
-- packages/document-service/src/sensitivity/tunables.ts for the loader.
--
-- Ownership note: bot_tunables lives in cip_hr today for historical
-- reasons (no platform schema exists yet). Doc-service has SELECT
-- access via the cip-documents DB user. A future "platform schema
-- split" slice may move bot_tunables to a dedicated cip_platform DB.

INSERT INTO bot_tunables (tenant_id, key, value_json, notes) VALUES
  ('00000000-0000-0000-0000-000000000000', 'documents.cert_legacy_path',       'true',
   'Slice 58B: keep the legacy cert process_document tool alive in parallel with the new document_process MCP. Slice 58E flips this false and removes the legacy tool.'),
  ('00000000-0000-0000-0000-000000000000', 'documents.l3_enabled',             'true',
   'Run the L3 LLM sensitivity rubric (false skips the LLM call; tier defaults to max(L1,L2,floor)).'),
  ('00000000-0000-0000-0000-000000000000', 'documents.tier_override_floor',    '"public"',
   'Minimum sensitivity tier any doc in this tenant may receive. max(L1,L2,L3,floor) is the final tier.'),
  ('00000000-0000-0000-0000-000000000000', 'documents.l1_keywords',
   '["salary","ssn","w2","w4","1099","paystub","medical","nda","payroll","confidential","contract","hr-private"]',
   'Filename keywords scanned by L1 deterministic. Per-tenant overrides allow custom industry vocabulary.'),
  ('00000000-0000-0000-0000-000000000000', 'documents.av_max_file_size_mb',    '25',
   'Reject upload if larger than this (enforced at MCP boundary by document_process — TODO 58E once the cert legacy path is gone).'),
  ('00000000-0000-0000-0000-000000000000', 'documents.progress_subscription_ttl_seconds', '300',
   'How long the bot keeps the per-conversation NATS progress subscription alive after an upload (5 min default).')
ON CONFLICT (tenant_id, key) DO NOTHING;
