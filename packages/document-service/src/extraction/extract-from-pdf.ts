// Slice 58C-FIX — PDF text extraction with page-1 vision fallback.
//
// Strategy:
//   1. Walk pdfjs-dist's text layer (covers the 90% case — PDFs with
//      embedded type, including most exported reports + cert PDFs).
//   2. If the text layer is sparse (< minTextLayerChars), the PDF is
//      likely scanned-image. Render page 1 via @napi-rs/canvas and hand
//      the PNG to extract-from-image.
//
// Lazy imports — keeps the workflow bundle clean (kickoff hard rule:
// activity-side only).

import type { ExtractionResult } from './extract-from-text.js'
import { extractFromImage, type ImageExtractionInput } from './extract-from-image.js'

const PDFJS_BUILD = 'pdfjs-dist/legacy/build/pdf.mjs'

export interface PdfExtractionInput {
  buffer:               Buffer
  // Tunable threshold — below this many characters from the text layer
  // we assume the PDF is image-only and rasterise page 1 → vision OCR.
  // Default 100 chars; lg.extract_pdf_text_min_chars override.
  minTextLayerChars?:   number
  // When true (default), attempt the text-layer pass first. When false
  // (lg.extract_pdf_text_first=false), skip straight to render+vision.
  textLayerFirst?:      boolean
  // Forwarded to extract-from-image when the render fallback fires.
  // Caller (the activity) supplies these from env + tunables.
  visionFallback?: {
    tenantId:    string
    modelAlias:  string
    virtualKey:  string
    baseURL?:    string
  }
  // Hard cap on pages to walk for text-layer extraction. Mirrors the
  // existing extract-generic-features cap (50). PDFs with 500+ pages
  // shouldn't blow the activity timeout.
  maxPages?:           number
}

const DEFAULTS = {
  minTextLayerChars: 100,
  textLayerFirst:    true,
  maxPages:          50,
} as const

export async function extractFromPdf(input: PdfExtractionInput): Promise<ExtractionResult> {
  const minChars      = input.minTextLayerChars ?? DEFAULTS.minTextLayerChars
  const textFirst     = input.textLayerFirst    ?? DEFAULTS.textLayerFirst
  const maxPages      = input.maxPages          ?? DEFAULTS.maxPages

  // 1. Text-layer pass.
  let textLayer = ''
  let pageCount = 0
  if (textFirst) {
    try {
      const r = await extractTextLayer(input.buffer, maxPages)
      textLayer  = r.text
      pageCount  = r.pageCount
    } catch (err) {
      // Pdfjs blew up entirely — propagate to the caller so the activity
      // emits a CorruptDocument failure (matches existing 58B behaviour).
      throw err
    }
  }

  if (textLayer.trim().length >= minChars) {
    return {
      ocrText: textLayer,
      evidence: {
        source:    'pdfjs.text_layer',
        bytes:     input.buffer.length,
        pageCount,
        chars:     textLayer.length,
      },
    }
  }

  // 2. Render fallback. We can only do this when the caller supplied
  // vision credentials. Without them, return whatever sparse text we
  // got — it's the honest answer.
  if (!input.visionFallback) {
    return {
      ocrText: textLayer,
      evidence: {
        source:        'pdfjs.text_layer',
        bytes:         input.buffer.length,
        pageCount,
        chars:         textLayer.length,
        reason:        'sparse_text_no_fallback',
      },
    }
  }

  let pageImage: Buffer
  try {
    pageImage = await renderPage1ToPng(input.buffer)
  } catch (err) {
    // Render failed — degrade to whatever text we got from the layer.
    return {
      ocrText: textLayer,
      evidence: {
        source:    'pdfjs.text_layer',
        bytes:     input.buffer.length,
        pageCount,
        chars:     textLayer.length,
        reason:    'render_failed',
        error:     err instanceof Error ? err.message : String(err),
      },
    }
  }

  const fb = input.visionFallback
  const visionInput: ImageExtractionInput = {
    buffer:     pageImage,
    mimeType:   'image/png',
    tenantId:   fb.tenantId,
    modelAlias: fb.modelAlias,
    virtualKey: fb.virtualKey,
    ...(fb.baseURL ? { baseURL: fb.baseURL } : {}),
  }
  const visionResult = await extractFromImage(visionInput)

  return {
    ocrText: visionResult.ocrText,
    evidence: {
      source:        'pdf_page1_vision',
      bytes:         input.buffer.length,
      pageCount,
      textLayerChars: textLayer.length,
      vision:        visionResult.evidence,
    },
  }
}

async function extractTextLayer(
  buffer: Buffer,
  maxPages: number,
): Promise<{ text: string; pageCount: number }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pdfjs = await import(PDFJS_BUILD).catch(() => import('pdfjs-dist')) as any
  const docTask = pdfjs.getDocument({
    data:            new Uint8Array(buffer),
    useWorkerFetch:  false,
    disableFontFace: true,
    useSystemFonts:  false,
  })
  const pdf = await docTask.promise
  const pageCount = pdf.numPages
  let text = ''
  try {
    const cap = Math.min(pageCount, maxPages)
    for (let p = 1; p <= cap; p++) {
      const page = await pdf.getPage(p)
      const content = await page.getTextContent()
      const items = content.items as Array<{ str?: string }>
      text += items.map(i => i.str ?? '').join(' ') + '\n'
      page.cleanup()
    }
  } finally {
    await pdf.cleanup()
    await pdf.destroy?.()
  }
  return { text, pageCount }
}

async function renderPage1ToPng(buffer: Buffer): Promise<Buffer> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pdfjs = await import(PDFJS_BUILD).catch(() => import('pdfjs-dist')) as any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { createCanvas } = (await import('@napi-rs/canvas')) as any

  const loadingTask = pdfjs.getDocument({
    data:            new Uint8Array(buffer),
    disableFontFace: true,
    useSystemFonts:  false,
  })
  const pdf = await loadingTask.promise

  try {
    const page = await pdf.getPage(1)
    // Scale 1.5: gives roughly 918x1188 for letter-size (good for OCR
    // legibility). Lower scales lose small-print accuracy.
    const scale = 1.5
    const view  = page.getViewport({ scale })
    const canvas = createCanvas(Math.ceil(view.width), Math.ceil(view.height))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await page.render({ canvas: canvas as any, viewport: view }).promise
    const png = canvas.toBuffer('image/png')
    page.cleanup()
    return png
  } finally {
    await pdf.destroy?.()
  }
}
