// Slice 58B — perceptual hash of the document's first rendered page.
//
// PDF: render page 1 to RGBA via pdfjs-dist + @napi-rs/canvas (drop-in
//      browser-canvas API in a ~5MB native binary; node-canvas would
//      have added ~80MB and we're memory-constrained).  Then 8x8
//      avg-hash via sharp.
// Image MIMEs: hash the image directly via sharp.
// Other MIMEs: hash the file SHA prefix (already stored on documents).
//
// pHash details: 8x8 average-hash. Cheap, fast, identifies near-
// duplicate scans of the same form.  Not a security hash; useful for
// the 58F reclassification "looks like another doc we already
// processed" heuristic and for 58I template-and-compare.

import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { eq, sql } from 'drizzle-orm'
import { z } from 'zod'

import { getDb } from '../../../db/index.js'
import { systemActorContext, withActorContext } from '../../../db/rls.js'
import { documents, auditEvents } from '../../../db/schema.js'

export interface ComputeLayoutFingerprintInput {
  tenantId:   string
  documentId: string
}

export const ComputeLayoutFingerprintOutputSchema = z.object({
  fingerprint: z.string(),
})
export type ComputeLayoutFingerprintOutput = z.infer<typeof ComputeLayoutFingerprintOutputSchema>

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

export async function computeLayoutFingerprintActivity(
  input: ComputeLayoutFingerprintInput,
): Promise<ComputeLayoutFingerprintOutput> {
  const { tenantId, documentId } = input
  const db = getDb()

  const doc = await withActorContext(db, systemActorContext(tenantId), async (tx) => {
    const rows = await tx.select({
      id:       documents.id,
      s3Bucket: documents.s3Bucket,
      s3Key:    documents.s3Key,
      mimeType: documents.mimeType,
      sha256:   documents.sha256,
    })
      .from(documents)
      .where(eq(documents.id, documentId))
    return rows[0]
  })
  if (!doc) throw new Error(`compute-layout-fingerprint: document ${documentId} not found`)

  const obj = await getS3().send(new GetObjectCommand({ Bucket: doc.s3Bucket, Key: doc.s3Key }))
  if (!obj.Body) throw new Error(`compute-layout-fingerprint: empty s3 body`)
  const buffer = Buffer.from(await obj.Body.transformToByteArray())

  let fingerprint: string
  let source: 'image_pHash' | 'pdf_page1_pHash' | 'sha_prefix_fallback'
  try {
    if (doc.mimeType.startsWith('image/')) {
      fingerprint = await pHashImage(buffer)
      source = 'image_pHash'
    } else if (doc.mimeType === 'application/pdf') {
      fingerprint = await pHashPdfPage1(buffer)
      source = 'pdf_page1_pHash'
    } else {
      fingerprint = `sha256:${doc.sha256.slice(0, 32)}`
      source = 'sha_prefix_fallback'
    }
  } catch (err) {
    // Don't take down the workflow over a fingerprint — fall back to sha-
    // prefix so downstream code always has a value.
    console.warn(`[layout-fingerprint] failed: ${err instanceof Error ? err.message : String(err)} — falling back to sha-prefix`)
    fingerprint = `sha256:${doc.sha256.slice(0, 32)}`
    source = 'sha_prefix_fallback'
  }

  await withActorContext(db, systemActorContext(tenantId), async (tx) => {
    await tx.update(documents).set({
      layoutFingerprint: fingerprint,
      updatedAt:         sql`NOW()`,
    }).where(eq(documents.id, documentId))

    await tx.insert(auditEvents).values({
      tenantId,
      documentId,
      actorRole:  'system',
      // 'state_transition' is the closest fit in the audit_events
      // event_type CHECK; the layout fingerprint is an attribute, not
      // its own lifecycle event. Payload carries the actual fingerprint.
      eventType:  'state_transition',
      payload:    { kind: 'layout_fingerprinted', fingerprint, source, mimeType: doc.mimeType },
    })
  })

  return ComputeLayoutFingerprintOutputSchema.parse({ fingerprint })
}

// ─── Hashers ────────────────────────────────────────────────────────────

async function pHashImage(buffer: Buffer): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sharpMod = (await import('sharp')).default as any
  const raw = await sharpMod(buffer)
    .resize(8, 8, { fit: 'fill' })
    .grayscale()
    .raw()
    .toBuffer()
  return pHashFromGrayscale64(raw)
}

async function pHashPdfPage1(buffer: Buffer): Promise<string> {
  // pdfjs-dist's render() expects a CanvasRenderingContext2D-shaped
  // target.  @napi-rs/canvas is a drop-in implementation in a small
  // native binary.
  const pdfjs = await loadPdfjsForNode()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { createCanvas } = (await import('@napi-rs/canvas')) as any

  // disableFontFace etc. — keeps pdfjs from trying to load fonts via
  // OffscreenCanvas / browser APIs that don't exist server-side.
  // (`isEvalSupported` was removed from DocumentInitParameters in
  // pdfjs-dist v5.)
  const loadingTask = pdfjs.getDocument({
    data:                  new Uint8Array(buffer),
    disableFontFace:       true,
    useSystemFonts:        false,
  })
  const pdf = await loadingTask.promise

  let canvas: ReturnType<typeof createCanvas> | undefined
  try {
    const page  = await pdf.getPage(1)
    // 0.75 scale → typical letter-size page becomes ~612x792 → resampled
    // to 8x8 by sharp.  Smaller scales are cheaper but lose layout signal.
    const scale = 0.75
    const view  = page.getViewport({ scale })
    canvas = createCanvas(Math.ceil(view.width), Math.ceil(view.height))

    // pdfjs-dist v5 takes `canvas` (the element) — it pulls the 2d
    // context internally.  v4 took `canvasContext` directly; the cast
    // keeps us compatible with napi-rs/canvas's type surface.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await page.render({ canvas: canvas as any, viewport: view }).promise

    const rgba = canvas.toBuffer('image/png')
    page.cleanup()
    return await pHashImage(rgba)
  } finally {
    await pdf.destroy()
    canvas = undefined
  }
}

/**
 * Lazy-import pdfjs-dist with the legacy entrypoint that does not assume
 * a browser worker. Packaging-wise this matches the import pattern the
 * extract-generic-features activity already uses.
 */
async function loadPdfjsForNode(): Promise<typeof import('pdfjs-dist/legacy/build/pdf.mjs')> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod = await import('pdfjs-dist/legacy/build/pdf.mjs') as any
  return mod
}

function pHashFromGrayscale64(raw: Buffer): string {
  if (raw.length < 64) return 'phash:err'
  let sum = 0
  for (let i = 0; i < 64; i++) sum += raw[i]!
  const mean = sum / 64
  let bits = 0n
  for (let i = 0; i < 64; i++) {
    if (raw[i]! >= mean) bits |= (1n << BigInt(i))
  }
  return `phash:${bits.toString(16).padStart(16, '0')}`
}
