-- Slice 58E — phase 2 of MIME-aware extraction routing.
--
-- Adds an optional `mime_filter` column to extraction_strategies so a
-- tenant can register different strategy_name rows per (module,
-- doc_type, mime_class). Resolver matches mime_filter against the
-- doc's normalized MIME class (one of: 'pdf' | 'image' | 'plain_text'
-- | 'docx' | 'xlsx' | 'pptx' | 'unsupported').
--
-- Backwards-compatible: existing rows have mime_filter=NULL which
-- continues to match every MIME class (the pre-58E behavior).

ALTER TABLE cip_documents.extraction_strategies
  ADD COLUMN mime_filter TEXT;

COMMENT ON COLUMN cip_documents.extraction_strategies.mime_filter
  IS 'Optional MIME class filter; NULL matches every MIME (back-compat default).';
