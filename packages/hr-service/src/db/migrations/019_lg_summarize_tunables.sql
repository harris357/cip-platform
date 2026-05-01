-- Slice 46: tunables for the summarize node.
--
-- summarize compresses older messages into state.summary once
-- messages.length > lg.summarize_at. The keep-recent count is what
-- stays in the live messages array after the older tail is replaced
-- by a single SystemMessage carrying "[Earlier conversation summarized]".
-- summary_max_chars caps the summary so it doesn't grow unbounded.
--
-- All three are read via getTunable<T>() with code-resident fallbacks.

INSERT INTO bot_tunables (tenant_id, key, value_json, notes) VALUES
  ('00000000-0000-0000-0000-000000000000', 'lg.summarize_at',          '12',
   'Trigger summarize when messages.length exceeds this. 0 disables summarization.'),
  ('00000000-0000-0000-0000-000000000000', 'lg.summarize_keep_recent', '6',
   'How many most-recent messages stay in the live array after summarize runs.'),
  ('00000000-0000-0000-0000-000000000000', 'lg.summary_max_chars',     '2000',
   'Hard cap on state.summary length; oldest paragraph is dropped when exceeded.')
ON CONFLICT (tenant_id, key) DO NOTHING;

-- Routing rule: summarize is text rewriting, not planning. Cheap nemo
-- (cip-classifier) is the right model. Per-tenant escalation possible via
-- routing_rules overrides.
INSERT INTO routing_rules (service, purpose, alias, notes) VALUES
  ('bot', 'summarize', 'cip-classifier',
   'Slice 46: compresses older messages into state.summary. Reuses cip-classifier — same nemo model used by triage.')
ON CONFLICT (service, purpose) DO NOTHING;
