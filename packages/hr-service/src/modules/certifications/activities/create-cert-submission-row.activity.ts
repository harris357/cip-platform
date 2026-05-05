// Slice 58E — Route-A entry: cert workflow creates the cert_submissions
// row from the inbound ProcessDocumentInput.
//
// Pre-58E the row was created externally by the bot's `process_document`
// MCP tool (now deleted). Under Route-A doc-service is the upload entry
// point; the cert workflow owns its own submission row creation, keyed
// on the tenant + uploader from ProcessDocumentInput.
//
// Output is Zod-parsed before return (Non-Negotiable #5).

import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { getDb } from '../../../db/index.js';
import { withTenantRLS } from '../../../db/rls.js';
import { certSubmissions } from '../../../db/schema.js';

export const CreateCertSubmissionRowInputSchema = z.object({
  tenantId:           z.string().uuid(),
  documentId:         z.string().uuid(),
  uploaderEmployeeId: z.string(),
  /** S3 key forwarded from doc-service. Mapped to cert_submissions.object_store_key. */
  s3Key:              z.string(),
});
export type CreateCertSubmissionRowInput = z.infer<typeof CreateCertSubmissionRowInputSchema>;

export const CreateCertSubmissionRowOutputSchema = z.object({
  certSubmissionId: z.string().uuid(),
});
export type CreateCertSubmissionRowOutput = z.infer<typeof CreateCertSubmissionRowOutputSchema>;

export async function createCertSubmissionRowActivity(
  input: CreateCertSubmissionRowInput,
): Promise<CreateCertSubmissionRowOutput> {
  const validated = CreateCertSubmissionRowInputSchema.parse(input);
  const db = getDb();

  const certSubmissionId = randomUUID();

  await withTenantRLS(db, validated.tenantId, async (tx) => {
    await tx.insert(certSubmissions).values({
      id:               certSubmissionId,
      tenantId:         validated.tenantId,
      submittedBy:      validated.uploaderEmployeeId,
      objectStoreKey:   validated.s3Key,
      submissionStatus: 'pending',
    });
  });

  return CreateCertSubmissionRowOutputSchema.parse({ certSubmissionId });
}
