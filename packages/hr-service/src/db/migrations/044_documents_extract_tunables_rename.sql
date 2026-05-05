-- Slice 58E — rename `lg.extract_*` tunables to `documents.extract_*`.
--
-- The `lg.*` prefix belongs to bot-LangGraph runtime tunables;
-- doc-service tunables otherwise use `documents.*`. This migration
-- inserts `documents.*` rows alongside the existing `lg.*` rows and
-- copies the value_json verbatim. The doc-service tunables loader
-- (sensitivity/tunables.ts) reads `documents.*` first then falls
-- back to `lg.*` for one release. A follow-up cleanup migration
-- drops the `lg.*` rows once the new loader has rolled out.
--
-- `lg.cert_text_extraction_min_chars` renames to
-- `documents.cert_text_extraction_min_chars` (kept cert-scoped on the
-- documents prefix). Future "module-agnostic text-min-chars" can land
-- in a separate slice if a non-cert text extractor materialises.

INSERT INTO bot_tunables (tenant_id, key, value_json, notes)
SELECT
  tenant_id,
  replace(key, 'lg.', 'documents.') AS key,
  value_json,
  notes
FROM bot_tunables
WHERE key IN (
  'lg.extract_token_budget',
  'lg.cert_text_extraction_min_chars',
  'lg.extract_image_ocr_model',
  'lg.extract_pdf_text_first',
  'lg.extract_pdf_text_min_chars',
  'lg.extract_office_image_render',
  'lg.extractor_db_timeout_ms'
)
ON CONFLICT (tenant_id, key) DO NOTHING;

-- Note: lg.* rows are kept for one release. A follow-up cleanup
-- migration drops them once doc-service has rolled out the new loader.
