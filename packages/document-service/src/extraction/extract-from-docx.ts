// Slice 58C-FIX — DOCX text extraction via mammoth.
//
// mammoth.extractRawText is intentionally minimal: it walks the OOXML
// document.xml and emits text content with paragraph breaks, no styling.
// Good enough for classification + sensitivity scoring; we don't need
// HTML conversion for now (heavier, and irrelevant to the downstream
// readers).
//
// Lazy import: mammoth is only loaded inside the activity-side
// extractor. The workflow bundle (Temporal-isolate'd, can't reach
// node:tls) only sees a type stub via dynamic import.

import type { ExtractionResult } from './extract-from-text.js'

export async function extractFromDocx(buffer: Buffer): Promise<ExtractionResult> {
  const mammoth = await import('mammoth')

  const result = await mammoth.extractRawText({ buffer })

  // mammoth surfaces conversion warnings in result.messages — we keep
  // them as evidence for diagnostics; nothing here is fatal.
  const messages = (result.messages ?? []).map(m => `${m.type}: ${m.message}`)

  return {
    ocrText: result.value ?? '',
    evidence: {
      source:    'mammoth.extractRawText',
      bytes:     buffer.length,
      messages:  messages.slice(0, 20),    // bounded — DOCX with hundreds of warnings exists
      msgCount:  messages.length,
    },
  }
}
