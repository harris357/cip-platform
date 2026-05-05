// Slice 58A — module-side contract for document consumers.
//
// Every module that wants to receive documents from the doc-service
// pipeline MUST implement two activities, registered on its own
// Temporal task queue:
//
//   processDocument(input: ProcessDocumentInput) → ProcessDocumentOutput
//   revokeFor(input: RevokeForInput)             → RevokeForOutput
//
// Cert is the first consumer (slice 58E rewrites
// CertificationProcessingWorkflow to consume ProcessDocumentInput).
// Future modules add their own task queue + activity registration.
//
// The doc-service's routing workflow (58E) reads the
// document_routing_map table to find (taskQueue, workflowType) for
// a given (module, doc_type) and starts the module's workflow with
// ProcessDocumentInput as the args[0].
//
// Slice 58E note: the live `ProcessDocumentInput` shape moved to
// `./process-document.ts` (drift reconciliation header). That file
// is the source of truth; this file keeps the `RevokeFor*` schemas
// + `SensitivityTierSchema` only.

import { z } from 'zod';

export const SensitivityTierSchema = z.enum(['public','internal','confidential','restricted']);
export type SensitivityTier = z.infer<typeof SensitivityTierSchema>;

export const ProcessDocumentOutputSchema = z.object({
  moduleRecordId:     z.string(),                          // module-specific PK (e.g. cert_submissions.id)
  status:             z.enum(['accepted','needs_hitl','rejected']),
  rejectionReason:    z.string().optional(),
});
export type ProcessDocumentOutput = z.infer<typeof ProcessDocumentOutputSchema>;

export const RevokeForReasonSchema = z.enum([
  'reclassification',
  'manual_admin_revoke',
  'soft_purge',
  'hard_purge',
]);
export type RevokeForReason = z.infer<typeof RevokeForReasonSchema>;

export const RevokeForInputSchema = z.object({
  tenantId:               z.string().uuid(),
  documentId:             z.string().uuid(),
  moduleRecordId:         z.string(),
  reason:                 RevokeForReasonSchema,
  requestedByEmployeeId:  z.string().uuid(),
});
export type RevokeForInput = z.infer<typeof RevokeForInputSchema>;

export const RevokeForOutputSchema = z.object({
  success:              z.boolean(),
  revokedAt:            z.string().datetime(),
  /**
   * Human-readable list of compensating actions executed.  Examples for the
   * cert module: 'cert_submission.revoked', 'certification.revoked',
   * 'compliance_event.cert_revoked.published'.  On idempotent retry the
   * value is `['noop_already_revoked']`.
   */
  compensatingActions:  z.array(z.string()),
});
export type RevokeForOutput = z.infer<typeof RevokeForOutputSchema>;
