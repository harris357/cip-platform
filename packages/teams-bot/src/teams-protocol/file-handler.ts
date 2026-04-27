import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import type { Attachment, TurnContext } from 'botbuilder';
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

export async function downloadToObjectStore(
  attachment: Attachment,
  ctx: BotAuthContext,
): Promise<string> {
  const downloadUrl =
    (attachment.content as Record<string, unknown> | undefined)?.['downloadUrl'] as string | undefined
    ?? attachment.contentUrl;

  if (!downloadUrl) throw new Error('No download URL found on attachment');

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

function guessMimeType(filename: string, contentType?: string): string {
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
