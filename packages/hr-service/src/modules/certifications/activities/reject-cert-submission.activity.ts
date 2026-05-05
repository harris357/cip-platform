// Slice 58D-B — terminal-failure activity for cert submissions whose
// subject could not be resolved by MatchPersonWorkflow.
//
// Called by CertificationProcessingWorkflow when the matcher returns
// outcome='no_resolution' (zero candidates and admin TTL exhausted, or
// policy.onNoMatch='fail'). Updates cert_submissions.submission_status
// to 'failed' so downstream readers (get_submission_status, status
// cards) reflect the terminal state. The CHECK constraint on the
// column already permits 'failed'; see migration 002_domain_model.sql.
//
// No audit_events table exists in cip_hr today — the submission_status
// change + the workflow's structured ApplicationFailure carry the
// reason. If/when we add a generic audit table, write the row here.

import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { getDb } from '../../../db/index.js';
import { withTenantRLS } from '../../../db/rls.js';
import { certSubmissions } from '../../../db/schema.js';

export const RejectCertSubmissionInputSchema = z.object({
  tenantId:     z.string().uuid(),
  submissionId: z.string().uuid(),
  reason:       z.string(),
});
export type RejectCertSubmissionInput = z.infer<typeof RejectCertSubmissionInputSchema>;

export const RejectCertSubmissionOutputSchema = z.object({
  rejected: z.literal(true),
});
export type RejectCertSubmissionOutput = z.infer<typeof RejectCertSubmissionOutputSchema>;

export async function rejectCertSubmissionActivity(
  input: RejectCertSubmissionInput,
): Promise<RejectCertSubmissionOutput> {
  const validated = RejectCertSubmissionInputSchema.parse(input);
  const db = getDb();

  await withTenantRLS(db, validated.tenantId, async (tx) => {
    await tx
      .update(certSubmissions)
      .set({ submissionStatus: 'failed' })
      .where(eq(certSubmissions.id, validated.submissionId));
    // No audit_events table in cip_hr yet — the status flip +
    // the workflow's ApplicationFailure (type='SubjectUnresolved',
    // message includes `validated.reason`) is the audit trail today.
    void validated.reason;
  });

  return RejectCertSubmissionOutputSchema.parse({ rejected: true });
}
