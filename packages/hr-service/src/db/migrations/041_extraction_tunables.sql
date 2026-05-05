-- Slice 58C-FIX — extraction tunables for the MIME-aware doc-service
-- extraction layer + cert strategy text-vs-vision branching.
--
-- Naming note: kickoff doc names these `lg.*` (matching the existing
-- bot-side runtime tunable namespace). Doc-service reads them via the
-- same DOCUMENTS_TUNABLE_KEYS shadow loader (tunables.ts). 58E may
-- normalise to `documents.extract_*` for namespace cleanliness — see
-- cross-slice notes.
--
-- Tenants override platform defaults by inserting their own row with
-- the real tenant_id. Zero-UUID is the platform default catchall.

INSERT INTO bot_tunables (tenant_id, key, value_json, notes) VALUES
  ('00000000-0000-0000-0000-000000000000', 'lg.extract_token_budget', '30000',
   'Slice 58C-FIX: max chars of ocrText persisted to documents.generic_features.ocrText. Truncation marker appended at the extractor layer (not the LLM call site).'),
  ('00000000-0000-0000-0000-000000000000', 'lg.cert_text_extraction_min_chars', '200',
   'Slice 58C-FIX: cert strategy uses text-only extraction (cip-document) when ocrText >= this. Below threshold falls back to existing vision agent.'),
  ('00000000-0000-0000-0000-000000000000', 'lg.extract_image_ocr_model', '"cip-vision"',
   'Slice 58C-FIX: LiteLLM alias for image OCR (raw images + PDF page-1 render fallback). Tunable so future swaps to cip-ocr-image or similar are config-only.'),
  ('00000000-0000-0000-0000-000000000000', 'lg.extract_pdf_text_first', 'true',
   'Slice 58C-FIX: try pdfjs text-layer pass before render-fallback. Disable to force vision OCR for every PDF (more accurate, slower, costlier).'),
  ('00000000-0000-0000-0000-000000000000', 'lg.extract_pdf_text_min_chars', '100',
   'Slice 58C-FIX: below this many chars from the text layer the PDF is treated as scanned-image and rasterised → cip-vision.'),
  ('00000000-0000-0000-0000-000000000000', 'lg.extract_office_image_render', 'false',
   'Slice 58C-FIX: rasterise office docs (docx/pptx) to images for vision OCR? Default false — text extraction is enough; reserved for future "scan-only DOCX" pathologies.')
ON CONFLICT (tenant_id, key) DO NOTHING;
