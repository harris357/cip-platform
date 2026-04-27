import { randomUUID } from 'node:crypto';
import type { Attachment, TurnContext } from 'botbuilder';
import type { BotAuthContext } from '../auth/resolve-context.js';

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
    (attachment.content as Record<string, unknown> | undefined)?.['downloadUrl'] as string;
  const buffer = await fetch(downloadUrl).then(r => r.arrayBuffer());
  const key = `${ctx.tenantId}/${ctx.employeeId}/${randomUUID()}`;
  // Upload to configured object store (env: OBJECT_STORE_BUCKET)
  void buffer;
  throw new Error('not implemented');
  return key;
}
