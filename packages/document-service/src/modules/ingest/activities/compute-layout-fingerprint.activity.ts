// Slice 58B — perceptual hash of the document's first rendered page.
//
// PDF: render page 1 to PNG via pdfjs-dist + a node-canvas-free path
//      (sharp consumes the rasterised buffer). For 58B we use a
//      simplified approach: extract the first page's image OR fall
//      back to a sha-of-text-layer when render isn't available.
// Image MIMEs: hash the image directly via sharp.
// Other MIMEs: hash the file SHA prefix (already stored on documents).
//
// pHash details: 8x8 average-hash via sharp (cheap, fast, identifies
// near-duplicate scans of the same form). Not a security hash; useful
// for the 58F reclassification "looks like another doc we already
// processed" heuristic.

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
  try {
    if (doc.mimeType.startsWith('image/')) {
      fingerprint = await pHashImage(buffer)
    } else if (doc.mimeType === 'application/pdf') {
      // 58B simplification: derive fingerprint from the file's sha256
      // prefix. Page-1 rendering needs node-canvas + native deps that
      // aren't in the bundle yet; deferred to a follow-up tuning pass
      // since pHash on a flat raster of a typed PDF is not particularly
      // discriminative. The sha-prefix gives us exact-duplicate detect
      // for free, which is what the cluster currently needs.
      fingerprint = `sha256:${doc.sha256.slice(0, 32)}`
    } else {
      fingerprint = `sha256:${doc.sha256.slice(0, 32)}`
    }
  } catch (err) {
    // Don't take down the workflow over a fingerprint — fall back to sha-
    // prefix so downstream code always has a value.
    console.warn(`[layout-fingerprint] failed: ${err instanceof Error ? err.message : String(err)} — falling back to sha-prefix`)
    fingerprint = `sha256:${doc.sha256.slice(0, 32)}`
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
      payload:    { kind: 'layout_fingerprinted', fingerprint, mimeType: doc.mimeType },
    })
  })

  return ComputeLayoutFingerprintOutputSchema.parse({ fingerprint })
}

async function pHashImage(buffer: Buffer): Promise<string> {
  // 8x8 average-hash. Resize → grayscale → sample 64 pixels → bit per
  // pixel above the mean. 64-bit hex output. Not collision-resistant;
  // not security-grade. Useful for "near-duplicate of another scan?".
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sharpMod = (await import('sharp')).default as any
  const raw = await sharpMod(buffer)
    .resize(8, 8, { fit: 'fill' })
    .grayscale()
    .raw()
    .toBuffer()
  if (raw.length < 64) return `phash:err`
  let sum = 0
  for (let i = 0; i < 64; i++) sum += raw[i]!
  const mean = sum / 64
  let bits = 0n
  for (let i = 0; i < 64; i++) {
    if (raw[i]! >= mean) bits |= (1n << BigInt(i))
  }
  return `phash:${bits.toString(16).padStart(16, '0')}`
}
