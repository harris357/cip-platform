import { z } from 'zod';
import { S3Client, CreateBucketCommand } from '@aws-sdk/client-s3';

const OutputSchema = z.object({ bucket: z.string() });

let _s3: S3Client | undefined;

function getS3(): S3Client {
  if (!_s3) {
    const endpoint = process.env['AWS_ENDPOINT_URL'];
    _s3 = new S3Client({
      ...(endpoint ? { endpoint } : {}),
      region:         process.env['AWS_REGION'] ?? 'BHS',
      forcePathStyle: true,
      credentials: {
        accessKeyId:     process.env['AWS_ACCESS_KEY_ID'] ?? '',
        secretAccessKey: process.env['AWS_SECRET_ACCESS_KEY'] ?? '',
      },
    });
  }
  return _s3;
}

export async function createObjectStoreBuckets(input: { tenantId: string }): Promise<void> {
  const bucket = `cip-${input.tenantId}-uploads`;

  try {
    await getS3().send(new CreateBucketCommand({ Bucket: bucket }));
  } catch (err: unknown) {
    // BucketAlreadyOwnedByYou and BucketAlreadyExists are idempotent
    const code = (err as { Code?: string; name?: string }).Code
              ?? (err as { Code?: string; name?: string }).name
              ?? '';
    if (code !== 'BucketAlreadyOwnedByYou' && code !== 'BucketAlreadyExists') {
      throw err;
    }
  }

  OutputSchema.parse({ bucket });
}
