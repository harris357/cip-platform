// Slice 58B-2b — DUAL-PATH file handler.
//
// During the 58B/58E transition the bot supports BOTH file-upload pipelines:
//
//   ── LEGACY (cert_legacy_path = true; default through 58B) ──
//     downloadToObjectStore(): bot fetches CDN bytes → bot uploads to OVH →
//     bot calls hr-service `process_document(objectStoreKey)`.
//     Removed in 58E along with the hr-service tool.
//
//   ── NEW (cert_legacy_path = false; tested in 58B-2b, default flips in 58E) ──
//     downloadAttachmentToBuffer(): bot fetches CDN bytes only and forwards
//     them to doc-service `document_process(fileBase64, ...)`. Doc-service
//     does the OVH PutObject. Bytes hop bot→doc-service→S3 once
//     (hard rule #3).
//
// Both helpers share `detectFileAttachments` and `guessMimeType`.

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import type { TurnContext } from '@microsoft/agents-hosting';
import type { Attachment } from '@microsoft/agents-activity';
import type { BotAuthContext } from '../auth/resolve-context.js';

function getS3Client(): S3Client {
  const endpoint = process.env['AWS_ENDPOINT_URL'];
  return new S3Client({
    ...(endpoint !== undefined ? { endpoint } : {}),
    region: process.env['AWS_REGION'] ?? 'BHS',
    credentials: {
      accessKeyId: process.env['AWS_ACCESS_KEY_ID'] ?? '',
      secretAccessKey: process.env['AWS_SECRET_ACCESS_KEY'] ?? '',
    },
    forcePathStyle: true, // required for OVH S3-compatible endpoint
  });
}

export function detectFileAttachments(context: TurnContext): Attachment[] {
  return (context.activity.attachments ?? [])
    .filter(a => a.contentType !== 'text/html')
    .filter(a =>
      a.contentType === 'application/vnd.microsoft.teams.file.download.info' ||
      a.contentType === 'application/pdf' ||
      (a.contentType ?? '').startsWith('image/') ||
      typeof (a.content as Record<string, unknown> | undefined)?.['downloadUrl'] === 'string',
    );
}

function downloadUrlOf(attachment: Attachment): string {
  const url =
    (attachment.content as Record<string, unknown> | undefined)?.['downloadUrl'] as string | undefined
    ?? attachment.contentUrl;
  if (!url) throw new Error('No download URL found on attachment');
  return url;
}

/**
 * Streams the Teams CDN body into a Buffer plus the resolved metadata
 * the doc-service `document_process` tool needs. NEW PATH (58B+).
 *
 * Bytes go bot → doc-service → S3 once. The bot does NOT touch object
 * storage on this path — that's doc-service's job.
 */
export async function downloadAttachmentToBuffer(
  attachment: Attachment,
): Promise<{ buffer: Buffer; mimeType: string; fileName: string }> {
  const downloadUrl = downloadUrlOf(attachment);
  const fileName = attachment.name ?? 'upload';
  const mimeType = guessMimeType(fileName, attachment.contentType);

  const response = await fetch(downloadUrl);
  if (!response.ok) {
    throw new Error(`Failed to download file from Teams CDN: ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  return { buffer, mimeType, fileName };
}

/**
 * LEGACY: bot uploads directly to OVH and returns the S3 key. Used by the
 * cert-only `process_document(objectStoreKey)` flow. Stays alive while
 * `documents.cert_legacy_path = true`. Removed in 58E.
 */
export async function downloadToObjectStore(
  attachment: Attachment,
  ctx: BotAuthContext,
): Promise<string> {
  const downloadUrl = downloadUrlOf(attachment);

  const filename = attachment.name ?? 'upload';
  const mimeType = guessMimeType(filename, attachment.contentType);

  const response = await fetch(downloadUrl);
  if (!response.ok) {
    throw new Error(`Failed to download file from Teams CDN: ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());

  const bucket = process.env['OBJECT_STORE_BUCKET'];
  if (!bucket) throw new Error('OBJECT_STORE_BUCKET is not set');

  // Key pattern: {tenantId}/{employeeId}/{uuid}/{filename}
  // tenantId scopes the object to the right tenant in the shared bucket.
  const key = `${ctx.tenantId}/${ctx.employeeId}/${randomUUID()}/${filename}`;

  const s3 = getS3Client();
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: buffer,
    ContentType: mimeType,
    ContentLength: buffer.length,
  }));

  return key;
}

export function guessMimeType(filename: string, contentType?: string): string {
  if (contentType && contentType !== 'application/octet-stream') return contentType;
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    tiff: 'image/tiff',
    bmp: 'image/bmp',
  };
  return map[ext] ?? 'application/octet-stream';
}
