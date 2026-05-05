// Slice 58C-FIX — plain-text extractor.
//
// .txt / .md / .csv / .log / .json / .yaml — all UTF-8 decoded as-is.
// We don't do any fancy normalisation (collapsing whitespace, stripping
// front-matter, etc.) — downstream consumers (classifier, sensitivity)
// want the raw text, and any normalisation we do here is a layer that
// future tunables would have to undo.
//
// BOM-stripping is the one exception: a leading U+FEFF would confuse
// keyword scans, so we strip it.

export interface ExtractionResult {
  ocrText: string
  evidence: {
    source:     string
    [key: string]: unknown
  }
}

export async function extractFromText(buffer: Buffer): Promise<ExtractionResult> {
  let text = buffer.toString('utf-8')

  // Strip UTF-8 BOM if present.
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1)

  return {
    ocrText: text,
    evidence: {
      source: 'plain_text',
      bytes:  buffer.length,
    },
  }
}
