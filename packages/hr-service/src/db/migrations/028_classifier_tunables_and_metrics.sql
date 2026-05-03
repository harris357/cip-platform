-- Slice 56: tunables for the sklearn classifier + per-turn metrics columns.
--
-- enabled defaults to FALSE — same safe-rollout pattern as the grammar
-- router. Even when enabled, honor_decisions defaults FALSE for the
-- shadow phase. Operators flip honor_decisions=true tenant-by-tenant
-- after observing 1-2 weeks of agreement data.

INSERT INTO bot_tunables (tenant_id, key, value_json, notes) VALUES
  ('00000000-0000-0000-0000-000000000000', 'lg.classifier_enabled', 'false',
   'Per-tenant kill switch for the sklearn classifier. Default false; flip true tenant-by-tenant. Even when true, see lg.classifier_honor_decisions for shadow vs active routing.'),
  ('00000000-0000-0000-0000-000000000000', 'lg.classifier_honor_decisions', 'false',
   'When true, classify node ROUTES based on prediction (skip/clarify/disambiguate/narrow_plan). When false, predictions are recorded for shadow analysis but the graph falls through to triage as today.'),
  ('00000000-0000-0000-0000-000000000000', 'lg.classifier_uncertain_threshold', '0.65',
   'Classifier confidence below this falls through to triage even with honor_decisions=true.'),
  ('00000000-0000-0000-0000-000000000000', 'lg.classifier_high_threshold', '0.85',
   'Reserved — Phase 4 (skip-LLM) routing requires confidence above this.'),
  ('00000000-0000-0000-0000-000000000000', 'lg.classifier_service_url',
   '"http://intent-classifier.cip-app.svc.cluster.local:8000"',
   'Internal URL for the intent-classifier service.'),
  ('00000000-0000-0000-0000-000000000000', 'lg.classifier_timeout_ms', '500',
   'Hard timeout. Exceeded → fall through.')
ON CONFLICT (tenant_id, key) DO NOTHING;

-- Per-turn columns for shadow analysis. All nullable.
ALTER TABLE bot_turn_metrics
  ADD COLUMN IF NOT EXISTS classifier_intent     TEXT,
  ADD COLUMN IF NOT EXISTS classifier_confidence REAL,
  ADD COLUMN IF NOT EXISTS classifier_version    TEXT,
  ADD COLUMN IF NOT EXISTS classifier_decision   TEXT;
  -- classifier_decision in: fallthrough | clarify | skip | disambiguate | narrow_plan
