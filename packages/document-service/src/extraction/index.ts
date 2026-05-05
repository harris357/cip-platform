// Slice 58C-FIX — MIME-aware extractor dispatcher.
//
// Single entry point for the extract-generic-features activity. Every
// extractor is lazy-imported so workflow bundles (Temporal-isolated;
// no node:tls) don't pull mammoth/xlsx/jszip/openai/pdfjs through.
//
// Returns ExtractionResult ({ ocrText, evidence }) or throws an
// ApplicationFailure with type='UnsupportedMime' when the MIME class
// isn't supported (legacy office formats — kickoff hard rule #4).

import { ApplicationFailure } from '@temporalio/activity'

import { classifyMime, type MimeClass } from './classify-mime.js'
import type { ExtractionResult } from './extract-from-text.js'

export { classifyMime } from './classify-mime.js'
export type { MimeClass } from './classify-mime.js'
export { truncateToBudget, DEFAULT_TOKEN_BUDGET_CHARS } from './token-budget.js'
export type { ExtractionResult } from './extract-from-text.js'

/**
 * Per-MIME runtime configuration the dispatcher needs but the extractor
 * modules can't read on their own (the modules are pure — no DB, no
 * env). The activity layer assembles this from tunables + env.
 */
export interface ExtractFromAnyOptions {
  // Vision credentials — used by the image extractor and the PDF
  // render-fallback path.  When absent (e.g. unit tests), image MIMEs
  // throw and PDFs degrade to whatever text the text layer yielded.
  vision?: {
    tenantId:    string
    modelAlias:  string                   // 'cip-vision' (tunable)
    virtualKey:  string
    baseURL?:    string
  }
  // PDF tunables.
  pdf?: {
    minTextLayerChars?: number            // default 100
    textLayerFirst?:    boolean           // default true
    maxPages?:          number            // default 50
  }
}

export async function extractFromAny(
  buffer:    Buffer,
  mimeType:  string,
  fileName:  string,
  options:   ExtractFromAnyOptions = {},
): Promise<ExtractionResult> {
  const cls: MimeClass = classifyMime(mimeType, fileName)

  switch (cls) {
    case 'plain_text': {
      const { extractFromText } = await import('./extract-from-text.js')
      return extractFromText(buffer)
    }

    case 'docx': {
      const { extractFromDocx } = await import('./extract-from-docx.js')
      return extractFromDocx(buffer)
    }

    case 'xlsx': {
      const { extractFromXlsx } = await import('./extract-from-xlsx.js')
      return extractFromXlsx(buffer)
    }

    case 'pptx': {
      const { extractFromPptx } = await import('./extract-from-pptx.js')
      return extractFromPptx(buffer)
    }

    case 'image': {
      if (!options.vision) {
        throw ApplicationFailure.create({
          type: 'VisionUnavailable',
          message: 'extract-from-image requires vision credentials but none were supplied (tunable lg.extract_image_ocr_model not set?)',
          nonRetryable: true,
        })
      }
      const { extractFromImage } = await import('./extract-from-image.js')
      return extractFromImage({
        buffer,
        mimeType,
        tenantId:   options.vision.tenantId,
        modelAlias: options.vision.modelAlias,
        virtualKey: options.vision.virtualKey,
        ...(options.vision.baseURL ? { baseURL: options.vision.baseURL } : {}),
      })
    }

    case 'pdf': {
      const { extractFromPdf } = await import('./extract-from-pdf.js')
      return extractFromPdf({
        buffer,
        ...(options.pdf?.minTextLayerChars !== undefined ? { minTextLayerChars: options.pdf.minTextLayerChars } : {}),
        ...(options.pdf?.textLayerFirst    !== undefined ? { textLayerFirst:    options.pdf.textLayerFirst    } : {}),
        ...(options.pdf?.maxPages          !== undefined ? { maxPages:          options.pdf.maxPages          } : {}),
        ...(options.vision ? { visionFallback: options.vision } : {}),
      })
    }

    case 'unsupported':
    default: {
      throw ApplicationFailure.create({
        type:         'UnsupportedMime',
        message:      `Unsupported MIME for extraction: ${mimeType || '(empty)'} (fileName=${fileName}). ` +
                      'Convert legacy office formats (.doc/.xls/.ppt) to .docx/.xlsx/.pptx and re-upload.',
        nonRetryable: true,
      })
    }
  }
}
