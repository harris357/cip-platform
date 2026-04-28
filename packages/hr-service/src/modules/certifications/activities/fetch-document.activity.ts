import { z } from 'zod';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';

export interface FetchDocumentInput {
  tenantId: string;
  objectStoreKey: string;
}

export interface FetchDocumentOutput {
  documentBase64: string;
}

const FetchDocumentOutputSchema = z.object({
  documentBase64: z.string().min(1),
});

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

export async function fetchDocumentActivity(
  input: FetchDocumentInput,
): Promise<FetchDocumentOutput> {
  const bucket = process.env['OBJECT_STORE_BUCKET'] ?? 'cip-uploads';
  const resp = await getS3().send(
    new GetObjectCommand({ Bucket: bucket, Key: input.objectStoreKey }),
  );

  if (!resp.Body) throw new Error(`fetchDocumentActivity: empty body for key ${input.objectStoreKey}`);

  const bytes = await resp.Body.transformToByteArray();
  const documentBase64 = Buffer.from(bytes).toString('base64');

  return FetchDocumentOutputSchema.parse({ documentBase64 });
}
