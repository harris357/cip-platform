// Slice 58B (initial) → 58C-FIX (MIME-aware extraction).
//
// Generic feature extraction: pageCount, layout heuristics, image
// dimensions, and — new in 58C-FIX — uniform `ocrText` extraction
// across the eight supported MIME classes. The classifier, embedding,
// sensitivity scorer, and per-module strategies all consume `ocrText`
// from generic_features.
//
// Architecture decision (kickoff): extraction lives UPSTREAM in
// doc-service, not duplicated into each module's strategy. Strategies
// receive richer ocrText and don't re-extract.
//
// Output is Zod-parsed before return (Non-Negotiable #5).

import { ApplicationFailure } from '@temporalio/activity'
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { eq, sql } from 'drizzle-orm'
import { z } from 'zod'

import { getDb } from '../../../db/index.js'
import { systemActorContext, withActorContext } from '../../../db/rls.js'
import { documents, auditEvents } from '../../../db/schema.js'
import {
  classifyMime,
  extractFromAny,
  truncateToBudget,
  type MimeClass,
  type ExtractionResult,
  type ExtractFromAnyOptions,
} from '../../../extraction/index.js'
import { loadDocumentsTunables } from '../../../sensitivity/tunables.js'

export interface ExtractGenericFeaturesInput {
  tenantId:   string
  documentId: string
}

export const GenericFeaturesSchema = z.object({
  pageCount:        z.number().int().nonnegative(),
  hasTable:         z.boolean(),
  hasSignature:     z.boolean(),
  hasHandwriting:   z.boolean(),
  layoutType:       z.enum(['form', 'prose', 'mixed', 'image_only']),
  dominantColors:   z.array(z.string()),
  languageHint:     z.string(),
  ocrTextLength:    z.number().int().nonnegative(),
  ocrText:          z.string(),                                  // workflow only — also persisted via genericFeatures jsonb
  fileName:         z.string(),
  mimeType:         z.string(),
  imageDimensions:  z.object({ w: z.number().int(), h: z.number().int() }).optional(),
  // Slice 58C-FIX — provenance: which extractor ran + key params.
  extractionEvidence: z.record(z.unknown()).optional(),
  // Slice 58C-FIX — coarse class so downstream consumers can branch
  // (cert strategy uses this to short-circuit when class is image and
  // ocrText is sparse).
  mimeClass:        z.enum(['pdf', 'image', 'plain_text', 'docx', 'xlsx', 'pptx', 'unsupported']).optional(),
})
export type GenericFeatures = z.infer<typeof GenericFeaturesSchema>

let _s3: S3Client | undefined
function getS3(): S3Client {
  if (!_s3) {
    const endpoint = process.env['AWS_ENDPOINT_URL']
    _s3 = new S3Client({
      ...(endpoint ? { endpoint } : {}),
      region:         process.env['AWS_REGION']?.toLowerCase() ?? 'bhs',
      forcePathStyle: true,
      credentials: {
        accessKeyId:     process.env['AWS_ACCESS_KEY_ID'] ?? '',
        secretAccessKey: process.env['AWS_SECRET_ACCESS_KEY'] ?? '',
      },
    })
  }
  return _s3
}

export async function extractGenericFeaturesActivity(
  input: ExtractGenericFeaturesInput,
): Promise<GenericFeatures> {
  const { tenantId, documentId } = input
  const db = getDb()

  // 1. Look up doc.
  const doc = await withActorContext(db, systemActorContext(tenantId), async (tx) => {
    const rows = await tx.select({
      id:             documents.id,
      lifecycleState: documents.lifecycleState,
      s3Bucket:       documents.s3Bucket,
      s3Key:          documents.s3Key,
      fileName:       documents.fileName,
      mimeType:       documents.mimeType,
    })
      .from(documents)
      .where(eq(documents.id, documentId))
    return rows[0]
  })
  if (!doc) throw new Error(`extractGenericFeatures: document ${documentId} not found`)

  // 2. Fetch bytes.
  const obj = await getS3().send(new GetObjectCommand({ Bucket: doc.s3Bucket, Key: doc.s3Key }))
  if (!obj.Body) throw new Error(`extractGenericFeatures: empty body for s3://${doc.s3Bucket}/${doc.s3Key}`)
  const buffer = Buffer.from(await obj.Body.transformToByteArray())

  // 3. Confirm MIME via magic bytes (file-type is ESM-only).
  let detectedMime = doc.mimeType
  try {
    const { fileTypeFromBuffer } = await import('file-type')
    const det = await fileTypeFromBuffer(buffer)
    if (det?.mime) detectedMime = det.mime
  } catch (err) {
    console.warn(`[extract-generic] file-type failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  // 4. Load tunables (token budget, vision model alias, PDF text-first
  // toggle, etc.).
  const tunables = await loadDocumentsTunables(tenantId)

  // 5. Classify MIME and route.
  const mimeClass: MimeClass = classifyMime(detectedMime, doc.fileName)

  let extraction: ExtractionResult
  let imageDimensions: { w: number; h: number } | undefined
  let dominantColors: string[] = []
  let pageCount = 0

  if (mimeClass === 'unsupported') {
    // Persist a clean failure marker rather than throwing — the
    // workflow can still progress to classify with empty text and the
    // classifier will route to HITL on low confidence. The audit event
    // captures the reason.
    extraction = {
      ocrText: '',
      evidence: { source: 'unsupported_mime', detectedMime, claimedMime: doc.mimeType, fileName: doc.fileName },
    }
  } else {
    // Vision credentials — only assembled when the MIME class might
    // need them (image, or pdf-with-render-fallback).
    const virtualKey = process.env['LITELLM_VIRTUAL_KEY']
    const visionOpts = virtualKey ? {
      tenantId,
      modelAlias: tunables.extractImageOcrModel,
      virtualKey,
      ...(process.env['LITELLM_BASE_URL'] ? { baseURL: process.env['LITELLM_BASE_URL'] } : {}),
    } : undefined

    const opts: ExtractFromAnyOptions = {
      ...(visionOpts ? { vision: visionOpts } : {}),
      pdf: {
        textLayerFirst:    tunables.extractPdfTextFirst,
        minTextLayerChars: tunables.extractPdfTextMinChars,
        maxPages:          50,
      },
    }

    try {
      extraction = await extractFromAny(buffer, detectedMime, doc.fileName, opts)
    } catch (err) {
      // ApplicationFailure preserves nonRetryable; rethrow so workflow's
      // retry policy sees it.
      if (err instanceof ApplicationFailure) {
        await recordExtractionFailure(tenantId, documentId, mimeClass, err.message)
        throw err
      }
      // Unknown error — surface as a generic extraction failure (retryable).
      const msg = err instanceof Error ? err.message : String(err)
      await recordExtractionFailure(tenantId, documentId, mimeClass, msg)
      throw err
    }
  }

  // 6. Truncate to budget at the extractor layer (kickoff hard rule #3).
  const truncated = truncateToBudget(extraction.ocrText, tunables.extractTokenBudget)

  // 7. Type-specific augmentation: image MIMEs still need sharp for
  // dimensions + dominant colours. PDFs get pageCount from extraction
  // evidence. Plain-text/office formats: pageCount=0, no dims.
  if (mimeClass === 'image') {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sharpMod = (await import('sharp')).default as any
      const meta = await sharpMod(buffer).metadata()
      if (meta.width && meta.height) imageDimensions = { w: meta.width, h: meta.height }
      try {
        const stats = await sharpMod(buffer).stats()
        if (stats.dominant) {
          const { r, g, b } = stats.dominant
          dominantColors = [`#${[r, g, b].map((v: number) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('')}`]
        }
      } catch { /* nice-to-have */ }
    } catch (err) {
      console.warn(`[extract-generic] sharp failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    pageCount = 1
  } else if (mimeClass === 'pdf') {
    const ev = extraction.evidence as { pageCount?: number }
    pageCount = ev.pageCount ?? 0
  } else if (mimeClass === 'pptx') {
    const ev = extraction.evidence as { slideCount?: number }
    pageCount = ev.slideCount ?? 0
  } else if (mimeClass === 'xlsx') {
    const ev = extraction.evidence as { sheetCount?: number }
    pageCount = ev.sheetCount ?? 0
  }

  // 8. Heuristics over the (possibly truncated) text.
  const hasTable        = mimeClass === 'xlsx' || /\b(\|\s+\|)|(\s+\|\s+)/.test(truncated) || /\btable\b/i.test(truncated)
  const hasSignature    = /\b(signature|signed by|\/s\/)\b/i.test(truncated)
  const hasHandwriting  = false   // vision-augmented signal — left to per-module strategies
  const layoutType: GenericFeatures['layoutType'] =
      mimeClass === 'image' ? 'image_only'
    : mimeClass === 'xlsx'  ? 'form'
    : truncated.length > 200 ? 'prose'
    : 'mixed'

  const features: GenericFeatures = {
    pageCount,
    hasTable,
    hasSignature,
    hasHandwriting,
    layoutType,
    dominantColors,
    languageHint:   guessLanguage(truncated),
    ocrTextLength:  truncated.length,
    ocrText:        truncated,
    fileName:       doc.fileName,
    mimeType:       detectedMime,
    ...(imageDimensions ? { imageDimensions } : {}),
    extractionEvidence: extraction.evidence,
    mimeClass,
  }

  // 9. Persist genericFeatures (excluding ocrText for size). Persist
  // ocrText IN the jsonb — kickoff explicitly says downstream consumers
  // read it from generic_features.ocrText.
  const { ocrText: _ocrTextWf, ...persistedFeatures } = features
  void _ocrTextWf

  await withActorContext(db, systemActorContext(tenantId), async (tx) => {
    await tx.update(documents).set({
      // Persist ocrText alongside the structural features. Bounded by
      // truncateToBudget so the JSONB row stays <40KB in practice.
      genericFeatures: { ...persistedFeatures, ocrText: truncated },
      updatedAt:       sql`NOW()`,
    }).where(eq(documents.id, documentId))

    await tx.insert(auditEvents).values({
      tenantId,
      documentId,
      actorRole:  'system',
      eventType:  'generic_features_extracted',
      payload: {
        layoutType:    features.layoutType,
        pageCount:     features.pageCount,
        ocrTextLength: features.ocrTextLength,
        mimeClass,
        evidenceSource: (extraction.evidence as { source?: string }).source ?? 'unknown',
      },
    })
  })

  return GenericFeaturesSchema.parse(features)
}

async function recordExtractionFailure(
  tenantId:   string,
  documentId: string,
  mimeClass:  MimeClass,
  message:    string,
): Promise<void> {
  const db = getDb()
  await withActorContext(db, systemActorContext(tenantId), async (tx) => {
    await tx.insert(auditEvents).values({
      tenantId,
      documentId,
      actorRole:  'system',
      eventType:  'extraction_failed',
      payload: {
        phase: 'generic_features',
        mimeClass,
        error: message,
      },
    })
  })
}

function guessLanguage(text: string): string {
  if (!text || text.length < 50) return 'und'
  const lc = text.toLowerCase()
  const enHits = (lc.match(/\b(the|and|is|to|for|of|on|with|that|this|are|was|be)\b/g) ?? []).length
  if (enHits >= 5) return 'en'
  return 'und'
}
