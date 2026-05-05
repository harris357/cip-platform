// Slice 58B — clamav INSTREAM scan activity.
//
// Reads the document row → fetches the S3 body → streams into clamd.
// On clean: transitions documents to 'scanning' (active) and the
// workflow advances. On detection: transitions to 'scan_failed' and
// throws an ApplicationFailure with type='ThreatDetected' to short-
// circuit retries (non-retryable). Connection errors throw a normal
// Error — Temporal retries per the proxy retry policy.

import { ApplicationFailure } from '@temporalio/activity'
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { eq, sql } from 'drizzle-orm'
import { z } from 'zod'

import { getDb } from '../../../db/index.js'
import { systemActorContext, withActorContext } from '../../../db/rls.js'
import { documents, auditEvents } from '../../../db/schema.js'
import { ClamAVClient } from '../../../av/clamav-client.js'
import { assertCanTransition } from '../../../lifecycle/states.js'

export interface ScanForVirusesInput {
  tenantId:   string
  documentId: string
}

const ScanForVirusesOutputSchema = z.object({
  clean:                 z.boolean(),
  threat:                z.string().optional(),
  signatureDbAgeSeconds: z.number().int().nonnegative().optional(),
})
export type ScanForVirusesOutput = z.infer<typeof ScanForVirusesOutputSchema>

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

const clamav = new ClamAVClient()

export async function scanForVirusesActivity(
  input: ScanForVirusesInput,
): Promise<ScanForVirusesOutput> {
  const { tenantId, documentId } = input
  const db = getDb()

  // 1. Look up storage coords + transition quarantined → scanning.
  const doc = await withActorContext(db, systemActorContext(tenantId), async (tx) => {
    const rows = await tx.select({
      id:             documents.id,
      lifecycleState: documents.lifecycleState,
      s3Bucket:       documents.s3Bucket,
      s3Key:          documents.s3Key,
      sha256:         documents.sha256,
    })
      .from(documents)
      .where(eq(documents.id, documentId))
    return rows[0]
  })
  if (!doc) throw new Error(`scanForViruses: document ${documentId} not found`)

  // Idempotency: if a retry comes in after transition, skip the state push.
  if (doc.lifecycleState === 'quarantined') {
    assertCanTransition('quarantined', 'scanning')
    await withActorContext(db, systemActorContext(tenantId), async (tx) => {
      await tx.update(documents)
        .set({ lifecycleState: 'scanning', updatedAt: sql`NOW()` })
        .where(eq(documents.id, documentId))
    })
  }

  // 2. Pull bytes from object store.
  const bucket = doc.s3Bucket
  const key    = doc.s3Key
  const obj = await getS3().send(new GetObjectCommand({ Bucket: bucket, Key: key }))
  if (!obj.Body) throw new Error(`scanForViruses: empty body for s3://${bucket}/${key}`)
  const buffer = Buffer.from(await obj.Body.transformToByteArray())

  // 3. INSTREAM to clamd — connection errors propagate (retryable).
  const result = await clamav.scanBuffer(buffer)

  // 4. Persist scan outcome + audit event.
  const ageSeconds = result.signatureDbAgeSeconds  // clamscan doesn't always populate this
  await withActorContext(db, systemActorContext(tenantId), async (tx) => {
    if (result.clean) {
      await tx.update(documents).set({
        scannedAt: sql`NOW()`,
        ...(ageSeconds !== undefined ? { avSignatureDbAgeSeconds: ageSeconds } : {}),
        updatedAt: sql`NOW()`,
      }).where(eq(documents.id, documentId))
    } else {
      assertCanTransition('scanning', 'scan_failed')
      await tx.update(documents).set({
        lifecycleState:  'scan_failed',
        avThreatName:    result.threat ?? 'unknown',
        scannedAt:       sql`NOW()`,
        ...(ageSeconds !== undefined ? { avSignatureDbAgeSeconds: ageSeconds } : {}),
        stateReason:     `threat:${result.threat ?? 'unknown'}`,
        updatedAt:       sql`NOW()`,
      }).where(eq(documents.id, documentId))
    }

    await tx.insert(auditEvents).values({
      tenantId,
      documentId,
      actorRole:  'system',
      eventType:  'scanned',
      payload: {
        clean:    result.clean,
        threat:   result.threat ?? null,
        sha256:   doc.sha256,
        signatureDbAgeSeconds: ageSeconds ?? null,
      },
    })
  })

  // 5. On detection, throw a non-retryable ApplicationFailure so Temporal
  // doesn't waste retries scanning the same infected file.
  if (!result.clean) {
    throw ApplicationFailure.create({
      type: 'ThreatDetected',
      message: `Threat detected: ${result.threat ?? 'unknown'}`,
      nonRetryable: true,
      details: [{ documentId, threat: result.threat }],
    })
  }

  return ScanForVirusesOutputSchema.parse({
    clean:                 result.clean,
    ...(result.threat !== undefined ? { threat: result.threat } : {}),
    ...(ageSeconds !== undefined ? { signatureDbAgeSeconds: ageSeconds } : {}),
  })
}
