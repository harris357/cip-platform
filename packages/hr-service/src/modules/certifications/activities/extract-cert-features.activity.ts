// Slice 58C — cert extraction strategy.
//
// The doc-service classify+extract phase loop dispatches every
// (module='certificate', doc_type=*) doc here via the cross-queue
// `ExecuteExtractionStrategyWorkflow`. We're the seam between the
// generic ExtractionInput/Output contract and the existing vision
// agent (which has its own historical signature — kept untouched per
// kickoff hard rule).
//
// S3 access: hr-service has the same OVH credentials as doc-service
// via the service secret (kickoff correction #5). We GetObject directly
// off the bucket+key supplied in the input — no presigned URL, no
// extra round-trip.

import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { activityInfo } from '@temporalio/activity';

import {
  ExtractionInputSchema,
  ExtractionOutputSchema,
  type ExtractionInput,
  type ExtractionOutput,
} from '@cip/shared';

import { runVisionAgent } from '../agents/vision-agent/index.js';

let _s3: S3Client | undefined;
function getS3(): S3Client {
  if (!_s3) {
    const endpoint = process.env['AWS_ENDPOINT_URL'];
    _s3 = new S3Client({
      ...(endpoint ? { endpoint } : {}),
      region:         process.env['AWS_REGION']?.toLowerCase() ?? 'bhs',
      forcePathStyle: true,
      credentials: {
        accessKeyId:     process.env['AWS_ACCESS_KEY_ID'] ?? '',
        secretAccessKey: process.env['AWS_SECRET_ACCESS_KEY'] ?? '',
      },
    });
  }
  return _s3;
}

/**
 * Map the strategy doc_type string into the certType hint the existing
 * vision agent's prompt template expects.  '*' / 'unknown' / empty all
 * fall through to a neutral 'certificate' hint — the agent's prompt is
 * generic enough that a missing sub-type just means it doesn't pre-bias
 * the field extraction toward (e.g.) CPR-specific fields.
 */
function inferCertTypeHint(docType: string): string {
  if (!docType || docType === '*' || docType === 'unknown') return 'certificate';
  return docType;
}

export async function extractCertFeaturesActivity(
  input: ExtractionInput,
): Promise<ExtractionOutput> {
  const validated = ExtractionInputSchema.parse(input);

  // Fetch bytes from S3. Cert vision agent expects base64.
  const obj = await getS3().send(new GetObjectCommand({
    Bucket: validated.s3Bucket,
    Key:    validated.s3Key,
  }));
  if (!obj.Body) {
    throw new Error(`extract-cert-features: empty body for s3://${validated.s3Bucket}/${validated.s3Key}`);
  }
  const bytes = await obj.Body.transformToByteArray();
  const documentBase64 = Buffer.from(bytes).toString('base64');

  const info = activityInfo();
  const workflowId = info.workflowExecution?.workflowId ?? `extract-cert-features-${validated.documentId}`;

  const vision = await runVisionAgent({
    tenantId:        validated.tenantId,
    workerId:        '00000000-0000-0000-0000-000000000000',  // subject resolution lands in 58D
    certificationId: validated.documentId,                     // correlation id reuse
    documentBase64,
    certType:        inferCertTypeHint(validated.docType),
    workflowId,
    activityId:      info.activityId,
  });

  // Adapt cert-shaped ExtractionResult → strategy-shaped ExtractionOutput.
  return ExtractionOutputSchema.parse({
    fields:               vision.extractedFields,
    extractionConfidence: vision.overallConfidence,
    evidence: {
      source:        'vision-agent',
      modelUsed:     vision.modelUsed,
      promptVersion: vision.promptVersion,
      tokensUsed:    vision.tokensUsed,
      requiresHITL:  vision.requiresHITL,
      certType:      vision.certType,
    },
  });
}
