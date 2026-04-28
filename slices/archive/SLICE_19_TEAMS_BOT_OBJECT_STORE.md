# Slice 19 — Teams Bot: Object Store Upload

> **Prerequisite:** Slice 18 complete (SSO flow fixed, token cache in place).
> **Package:** `@cip/teams-bot`
> **Verify:** `pnpm --filter @cip/teams-bot typecheck`

---

## What You Are Building

`downloadToObjectStore` in `teams-protocol/file-handler.ts` currently throws
`new Error('not implemented')`. This means any file a user sends to the bot crashes
the message handler immediately — certificate uploads are completely broken.

This slice replaces the stub with a real implementation using the AWS S3 SDK
(which is also OVH Object Store-compatible — OVH exposes an S3-compatible API).

The flow:
1. Detect file attachment (already done — `detectFileAttachments` works)
2. Download the file from the Teams CDN download URL (already done — `fetch(downloadUrl)`)
3. **Upload the buffer to OVH Object Store using S3 `PutObjectCommand`** ← this is what's missing
4. Return the object store key to be passed to the MCP `process_document` tool

---

## Read Before Writing

- `packages/teams-bot/src/teams-protocol/file-handler.ts`
- `packages/teams-bot/package.json`
- `packages/teams-bot/helm/values.yaml`
- `packages/teams-bot/helm/templates/deployment.yaml`

Do NOT read any hr-service or shared packages — this slice touches only the teams-bot.

---

## Files to Modify

```
packages/teams-bot/src/teams-protocol/file-handler.ts    ← implement downloadToObjectStore
packages/teams-bot/package.json                          ← add @aws-sdk/client-s3
packages/teams-bot/helm/values.yaml                      ← add OBJECT_STORE_BUCKET, AWS_ENDPOINT_URL, AWS_REGION
```

---

## `file-handler.ts` — Complete Implementation

Replace the stub body of `downloadToObjectStore` with:

```typescript
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import type { Attachment, TurnContext } from 'botbuilder';
import type { BotAuthContext } from '../auth/resolve-context.js';

function getS3Client(): S3Client {
  return new S3Client({
    endpoint: process.env['AWS_ENDPOINT_URL'],
    region: process.env['AWS_REGION'] ?? 'BHS',
    credentials: {
      accessKeyId: process.env['AWS_ACCESS_KEY_ID'] ?? '',
      secretAccessKey: process.env['AWS_SECRET_ACCESS_KEY'] ?? '',
    },
    forcePathStyle: true,   // required for OVH S3-compatible endpoint
  });
}

export function detectFileAttachments(context: TurnContext): Attachment[] {
  // Existing implementation — do not change
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
```

Note: `guessMimeType` replaces the inline logic that was previously part of the stub.
The `getS3Client()` helper is module-private — not exported.

---

## `package.json` — Add Dependency

Add to `dependencies`:

```json
"@aws-sdk/client-s3": "^3.600.0"
```

---

## `helm/values.yaml` — Object Store Env Vars

Add to the `env:` block:

```yaml
  OBJECT_STORE_BUCKET: cip-uploads     # override at deploy time per environment
  AWS_ENDPOINT_URL: https://s3.bhs.io.cloud.ovh.net
  AWS_REGION: BHS
```

The `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` must be stored in the
`teams-bot-credentials` K8s Secret (not hardcoded). Update the comment at the top
of `values.yaml` (added in Slice 18) to include these keys:

```yaml
# Required K8s Secret: teams-bot-credentials
# Keys: BOT_APP_ID, BOT_APP_PASSWORD, KEYCLOAK_CLIENT_SECRET, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
```

---

## Hard Rules

1. `tenantId` is part of the S3 key prefix — never upload to a flat key without it
2. `getS3Client()` is constructed per-call — no singleton needed (the AWS SDK pools connections)
3. `forcePathStyle: true` is mandatory — OVH S3 endpoint does not support virtual-hosted style
4. MIME type detection falls back to `application/octet-stream` — never throw on unknown extension
5. All credentials come from environment variables — no hardcoding

---

## Acceptance Criteria

- [ ] `downloadToObjectStore` no longer throws `not implemented`
- [ ] S3 key follows pattern `{tenantId}/{employeeId}/{uuid}/{filename}`
- [ ] `@aws-sdk/client-s3` added to `packages/teams-bot/package.json` dependencies
- [ ] `OBJECT_STORE_BUCKET`, `AWS_ENDPOINT_URL`, `AWS_REGION` in `helm/values.yaml`
- [ ] `teams-bot-credentials` secret comment updated to include `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`
- [ ] `pnpm --filter @cip/teams-bot typecheck` passes
