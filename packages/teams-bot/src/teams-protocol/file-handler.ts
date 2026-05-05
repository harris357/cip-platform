// Slice 58B-2b — Teams attachment → buffer.  Single-path now.
//
// Bot fetches CDN bytes and forwards them to doc-service
// `document_process(fileBase64, ...)`. Doc-service does the OVH
// PutObject. Bytes hop bot→doc-service→S3 once (hard rule #3).
//
// (The old `downloadToObjectStore` legacy path was removed once
// `documents.cert_legacy_path` was retired — see slice 58E for the
// hr-service-side cleanup of the matching MCP tool.)

import type { TurnContext } from '@microsoft/agents-hosting';
import type { Attachment } from '@microsoft/agents-activity';

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
 * the doc-service `document_process` tool needs.
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
 * Resolve the actual content MIME type for the upload.  Teams wraps
 * its file uploads with `application/vnd.microsoft.teams.file.download.info`
 * — that's a routing hint, not the real content type — so we treat it
 * the same way as `application/octet-stream` and fall through to
 * filename-extension guessing.
 *
 * Without this, doc-service's per-MIME pipeline (e.g. PDF page-1
 * pHash via @napi-rs/canvas) gets bypassed entirely for Teams
 * uploads, falling back to sha-prefix.
 */
const PLACEHOLDER_MIMETYPES = new Set([
  'application/octet-stream',
  'application/vnd.microsoft.teams.file.download.info',
]);

export function guessMimeType(filename: string, contentType?: string): string {
  if (contentType && !PLACEHOLDER_MIMETYPES.has(contentType)) return contentType;
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    pdf:  'application/pdf',
    png:  'image/png',
    jpg:  'image/jpeg',
    jpeg: 'image/jpeg',
    gif:  'image/gif',
    webp: 'image/webp',
    tiff: 'image/tiff',
    bmp:  'image/bmp',
  };
  return map[ext] ?? 'application/octet-stream';
}
