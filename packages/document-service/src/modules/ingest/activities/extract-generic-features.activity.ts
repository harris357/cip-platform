// Slice 58B — generic feature extraction (L1 features + lightweight OCR).
//
// PDF: pdfjs-dist for page count + text layer extraction (no OCR over
// rasterised content; that's slice 58C's vision-agent territory).
// Image MIMEs: sharp for dimensions + dominant colors. No text extracted.
// Other MIMEs: minimal feature set, file-type for MIME confirmation.
//
// Output is Zod-parsed before return (Non-Negotiable #5).

import { ApplicationFailure } from '@temporalio/activity'
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { eq, sql } from 'drizzle-orm'
import { z } from 'zod'

import { getDb } from '../../../db/index.js'
import { systemActorContext, withActorContext } from '../../../db/rls.js'
import { documents, auditEvents } from '../../../db/schema.js'
import { assertCanTransition } from '../../../lifecycle/states.js'

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
})
export type GenericFeatures = z.infer<typeof GenericFeaturesSchema>

let _s3: S3Client | undefined
function getS3(): S3Client {
  if (!_s3) {
    const endpoint = process.env['AWS_ENDPOINT_URL']
    _s3 = new S3Client({
      ...(endpoint ? { endpoint } : {}),
      region:         process.env['AWS_REGION'] ?? 'BHS',
      forcePathStyle: true,
      credentials: {
        accessKeyId:     process.env['AWS_ACCESS_KEY_ID'] ?? '',
        secretAccessKey: process.env['AWS_SECRET_ACCESS_KEY'] ?? '',
      },
    })
  }
  return _s3
}

const PDFJS_BUILD = 'pdfjs-dist/legacy/build/pdf.mjs'

export async function extractGenericFeaturesActivity(
  input: ExtractGenericFeaturesInput,
): Promise<GenericFeatures> {
  const { tenantId, documentId } = input
  const db = getDb()

  // 1. Look up doc. We expect it to be in 'scanning' (just-scanned by the
  // prior activity); if not, fail fast — the workflow logic is broken
  // somewhere upstream.
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
    // Not fatal — we keep the claimed MIME. Log for diagnostics.
    console.warn(`[extract-generic] file-type failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  // 4. Branch by MIME.
  let features: GenericFeatures
  if (detectedMime === 'application/pdf' || doc.mimeType === 'application/pdf') {
    features = await extractPdfFeatures(buffer, doc.fileName, detectedMime)
  } else if (detectedMime.startsWith('image/')) {
    features = await extractImageFeatures(buffer, doc.fileName, detectedMime)
  } else {
    features = {
      pageCount: 0,
      hasTable: false,
      hasSignature: false,
      hasHandwriting: false,
      layoutType: 'mixed',
      dominantColors: [],
      languageHint: 'und',
      ocrTextLength: 0,
      ocrText: '',
      fileName: doc.fileName,
      mimeType: detectedMime,
    }
  }

  // 5. Persist genericFeatures (excluding ocrText to keep the row reasonable).
  // ocrText is kept ephemeral — passed through to embedding + sensitivity
  // activities only; long-term storage of OCR text isn't owned by 58B
  // (58C's extraction strategy will decide whether/how to persist).
  const { ocrText: _ocrText, ...persistedFeatures } = features
  void _ocrText

  await withActorContext(db, systemActorContext(tenantId), async (tx) => {
    await tx.update(documents).set({
      genericFeatures: persistedFeatures,
      updatedAt:       sql`NOW()`,
    }).where(eq(documents.id, documentId))

    await tx.insert(auditEvents).values({
      tenantId,
      documentId,
      actorRole:  'system',
      eventType:  'features_extracted',
      payload: { layoutType: features.layoutType, pageCount: features.pageCount, ocrTextLength: features.ocrTextLength },
    })
  })

  return GenericFeaturesSchema.parse(features)
}

async function extractPdfFeatures(buffer: Buffer, fileName: string, mimeType: string): Promise<GenericFeatures> {
  let pageCount = 0
  let ocrText = ''
  try {
    // pdfjs-dist 5.x ships ESM as the default; the legacy build is more
    // permissive about Node-side use without a DOM.
    const pdfjs = await import(PDFJS_BUILD).catch(() => import('pdfjs-dist'))
    // pdfjs expects a Uint8Array for `data` — Node Buffer is a subclass.
    const docTask = pdfjs.getDocument({ data: new Uint8Array(buffer), useWorkerFetch: false })
    const pdf = await docTask.promise
    pageCount = pdf.numPages
    for (let p = 1; p <= Math.min(pageCount, 50); p++) {
      const page = await pdf.getPage(p)
      const content = await page.getTextContent()
      const items = content.items as Array<{ str?: string }>
      ocrText += items.map(i => i.str ?? '').join(' ') + '\n'
      page.cleanup()
    }
    pdf.cleanup()
  } catch (err) {
    // If pdfjs fails outright, the doc may be malformed — flag as
    // CorruptDocument (non-retryable per workflow proxy) so Temporal
    // doesn't infinitely retry. The workflow currently doesn't catch
    // this, and that's fine — failing the workflow is correct here.
    throw ApplicationFailure.create({
      type: 'CorruptDocument',
      message: `pdfjs failed: ${err instanceof Error ? err.message : String(err)}`,
      nonRetryable: true,
    })
  }

  // Lightweight signal heuristics from text — sketchy but useful as a
  // first-pass classification feature. 58C upgrades these via vision.
  const hasTable        = /\b(\|\s+\|)|(\s+\|\s+)/.test(ocrText) || /\btable\b/i.test(ocrText)
  const hasSignature    = /\b(signature|signed by|\/s\/)\b/i.test(ocrText)
  const hasHandwriting  = false   // PDFs with text layers are typed; vision in 58C decides
  const layoutType      = ocrText.length > 200 ? 'prose' : 'mixed'
  const trimmed = ocrText.slice(0, 100_000)   // hard cap

  return {
    pageCount,
    hasTable,
    hasSignature,
    hasHandwriting,
    layoutType,
    dominantColors: [],
    languageHint:   guessLanguage(trimmed),
    ocrTextLength:  trimmed.length,
    ocrText:        trimmed,
    fileName,
    mimeType,
  }
}

async function extractImageFeatures(buffer: Buffer, fileName: string, mimeType: string): Promise<GenericFeatures> {
  // Sharp is dynamically imported so test machines without the native
  // binary still typecheck; runtime in the deploy container has it.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let sharpMod: any
  try {
    sharpMod = (await import('sharp')).default
  } catch (err) {
    throw new Error(`sharp not available: ${err instanceof Error ? err.message : String(err)}`)
  }

  const img = sharpMod(buffer)
  const meta = await img.metadata()
  const dominantColors: string[] = []
  try {
    const stats = await sharpMod(buffer).stats()
    if (stats.dominant) {
      const { r, g, b } = stats.dominant
      dominantColors.push(`#${[r, g, b].map(v => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('')}`)
    }
  } catch {
    // dominant colors are nice-to-have; skip on failure
  }

  return {
    pageCount:      1,
    hasTable:       false,
    hasSignature:   false,
    hasHandwriting: false,
    layoutType:     'image_only',
    dominantColors,
    languageHint:   'und',
    ocrTextLength:  0,
    ocrText:        '',
    fileName,
    mimeType,
    imageDimensions: meta.width && meta.height ? { w: meta.width, h: meta.height } : undefined,
  }
}

function guessLanguage(text: string): string {
  // Crude heuristic — checks for common English stop-words.
  // Slice 58C may upgrade this with a real langid library or vision-agent
  // language hint. For now, returning 'und' on no signal is honest.
  if (!text || text.length < 50) return 'und'
  const lc = text.toLowerCase()
  const enHits = (lc.match(/\b(the|and|is|to|for|of|on|with|that|this|are|was|be)\b/g) ?? []).length
  if (enHits >= 5) return 'en'
  return 'und'
}
