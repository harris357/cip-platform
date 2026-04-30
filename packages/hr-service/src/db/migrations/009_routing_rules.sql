-- Slice 39A: store the (service, purpose) → alias mapping.
-- Aliases live in LiteLLM; this table picks WHICH alias each call site uses.
-- Tunable via SQL UPDATE; bot/hr-service cache 5 min.
--
-- service:  'bot' | 'hr-service' | 'platform-core' — closed enum, code-defined.
-- purpose:  service-defined snake_case identifier for the call site.
-- alias:    LiteLLM alias name (must exist in LiteLLM model_list or runtime DB).

CREATE TABLE IF NOT EXISTS routing_rules (
  service     TEXT        NOT NULL,
  purpose     TEXT        NOT NULL,
  alias       TEXT        NOT NULL,
  notes       TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by  TEXT,
  PRIMARY KEY (service, purpose)
);

-- Per-tenant routing override JSONB. Key shape: '<service>.<purpose>' = '<alias>'.
-- Resolved BEFORE the global routing_rules row when both are set.
ALTER TABLE tenant_settings
  ADD COLUMN IF NOT EXISTS routing_overrides JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Seed: every CURRENT call site preserved + new purposes registered (dormant
-- until consumers wire them up — call sites for the dormant purposes land in
-- Slice 39B and a future vision-agent refactor slice).
INSERT INTO routing_rules (service, purpose, alias, notes) VALUES
  -- bot: today's single-stage routing (used by router.ts as 'route_simple')
  ('bot',        'route_simple',        'cip-chat',           'Default tool-selection LLM call. Slice 39B will add route_careful + route_reasoning as alternates.'),

  -- bot: dormant — Slice 39B wires these
  ('bot',        'intent_classify',     'cip-classifier',     'Stage-1 intent classifier (Slice 39B).'),
  ('bot',        'route_careful',       'cip-router-careful', 'Stage-2 tool selection for HR admin (Slice 39B).'),
  ('bot',        'route_reasoning',     'cip-reasoning',      'Stage-2 tool selection for multi-step reasoning (Slice 39B).'),

  -- hr-service: existing call sites preserved
  ('hr-service', 'vision_extract',      'cip-vision',         'Vision agent OCR/extraction (existing).'),
  ('hr-service', 'employee_match',      'cip-lightweight',    'Match employee row by fuzzy name (existing).'),
  ('hr-service', 'cert_def_match',      'cip-lightweight',    'Match cert-definition by fuzzy name (existing).'),

  -- hr-service: dormant — registered for future vision-agent refactor.
  -- The "_small" variants are intentional cost knobs; callers pick based on input size.
  ('hr-service', 'ocr_document',        'cip-ocr-document',       'Full document OCR — quality-critical compliance docs.'),
  ('hr-service', 'ocr_document_small',  'cip-ocr-document-small', 'Draft / preview document OCR — cheap path.'),
  ('hr-service', 'ocr_image',           'cip-ocr-image',          'Photo of physical certificate — OCR + reasoning.'),
  ('hr-service', 'ocr_image_small',     'cip-ocr-image-small',    'Thumbnail / quick triage image OCR.'),
  ('hr-service', 'document_understand', 'cip-document',           'Text-only document reasoning, no OCR.')

ON CONFLICT (service, purpose) DO UPDATE
  SET alias      = EXCLUDED.alias,
      notes      = EXCLUDED.notes,
      updated_at = NOW(),
      updated_by = 'migration-009';
