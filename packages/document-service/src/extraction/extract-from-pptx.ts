// Slice 58C-FIX — PPTX text extraction via direct slide-XML walk.
//
// PPTX is a zip containing ppt/slides/slide<N>.xml + slide layouts +
// notesSlides + theme. We enumerate ppt/slides/slide*.xml in numeric
// order, strip <a:t> text runs (the OOXML text-run element), and join
// per-slide blocks with a separator.
//
// We deliberately don't try to extract speaker notes, alt-text on
// images, or master-slide footers — keeping the surface small avoids
// surprising the classifier with metadata that wasn't on the visible
// slide. If a slice 58E rule wants more, we can extend.
//
// Lazy import: jszip is loaded only inside the activity-side extractor.

import type { ExtractionResult } from './extract-from-text.js'

const TEXT_RUN_RE = /<a:t(?:\s[^>]*)?>([^<]*)<\/a:t>/g
const SLIDE_PATH_RE = /^ppt\/slides\/slide(\d+)\.xml$/

export async function extractFromPptx(buffer: Buffer): Promise<ExtractionResult> {
  const JSZipMod = await import('jszip')
  const JSZip = JSZipMod.default ?? JSZipMod

  const zip = await JSZip.loadAsync(buffer)

  // Collect slide entries in numeric order — JSZip iteration order is
  // insertion order, which matches presentation order in practice but
  // we sort to be defensive. (SlideN.xml where N can be > 9.)
  const slideEntries: Array<{ index: number; entry: import('jszip').JSZipObject }> = []
  zip.forEach((path, entry) => {
    const m = SLIDE_PATH_RE.exec(path)
    if (m && !entry.dir) {
      slideEntries.push({ index: Number(m[1]), entry })
    }
  })
  slideEntries.sort((a, b) => a.index - b.index)

  const parts: string[] = []
  for (const { index, entry } of slideEntries) {
    const xml = await entry.async('string')
    const runs: string[] = []
    let m: RegExpExecArray | null
    TEXT_RUN_RE.lastIndex = 0
    while ((m = TEXT_RUN_RE.exec(xml)) !== null) {
      const run = decodeXmlEntities(m[1] ?? '')
      if (run) runs.push(run)
    }
    if (runs.length > 0) {
      parts.push(`--- SLIDE ${index} ---\n${runs.join(' ')}`)
    }
  }

  return {
    ocrText: parts.join('\n\n'),
    evidence: {
      source:     'pptx.slide_xml',
      bytes:      buffer.length,
      slideCount: slideEntries.length,
    },
  }
}

// Minimal XML entity decoder — enough for the five spec-defined
// entities. We're decoding text-run inner content, not arbitrary XML.
function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}
