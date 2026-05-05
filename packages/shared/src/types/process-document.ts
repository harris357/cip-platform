// Slice 58E — `ProcessDocumentInput` cross-service contract.
//
// The doc-service `DocumentProcessingWorkflow` calls the routing
// dispatcher activity, which starts a downstream module workflow
// (e.g. cert) on its own task queue with this shape as args[0].
//
// Subject resolution is owned by the downstream module workflow (cert
// runs `MatchPersonWorkflow` as a child workflow); doc-service does
// NOT pre-resolve `subjectEmployeeId`. This is intentional — the
// matcher has different semantics per module (cert holder vs. invoice
// payer vs. training graduate) and lives in the module package.
//
// `extractionConfidence` is top-level. `extractedFeatures` is the
// generic per-doc-type field bag — for cert it carries
// holderName/holderEmail/certNumber/issueDate/expiryDate/issuingBody.
//
// `actorContext` carries the original uploader's identity envelope
// for downstream modules to authenticate further calls (e.g. into
// hr-service MCP) without doc-service impersonating a service
// principal.

import { z } from 'zod';

export const ProcessDocumentInputSchema = z.object({
  tenantId:             z.string().uuid(),
  documentId:           z.string().uuid(),
  /** AAD object id of the human who uploaded the file. */
  uploaderEmployeeId:   z.string(),
  /** Free-text accompanying message ("this is for me", etc.). */
  uploaderHintText:     z.string().optional(),
  /** Teams conversation id; required for live progress streaming. */
  conversationId:       z.string().optional(),
  /** Module-specific subtype, e.g. 'certificate.cpr' or '*'. */
  docType:              z.string(),
  /** L3 features extracted by doc-service's strategy registry. */
  extractedFeatures:    z.record(z.unknown()),
  /** Top-level confidence from the strategy's ExtractionOutput. */
  extractionConfidence: z.number().min(0).max(1),
  /** L1 features (ocrText, fileName, mimeType, pageCount, ...). */
  genericFeatures:      z.record(z.unknown()),
  sensitivityTier:      z.enum(['public','internal','confidential','restricted']),
  s3Bucket:             z.string(),
  s3Key:                z.string(),
  /** Forwarded actor envelope. Loose record so the slice doesn't lock the shape. */
  actorContext:         z.record(z.unknown()),
});
export type ProcessDocumentInput = z.infer<typeof ProcessDocumentInputSchema>;

/**
 * Doc-service signal payload — the downstream module workflow signals
 * back here once it has decided to accept/reject the doc. Doc-service
 * persists `moduleRecordId` on `documents.downstream_module_record_id`
 * and transitions lifecycle to 'archived' (accepted) or 'failed' (rejected).
 */
export const ModuleCallbackSignalSchema = z.object({
  moduleRecordId: z.string(),
  status:         z.enum(['accepted', 'rejected']),
  reason:         z.string().optional(),
});
export type ModuleCallbackSignal = z.infer<typeof ModuleCallbackSignalSchema>;

/**
 * Doc-service signal payload — admin tools resolve a `hitl_admin_queue`
 * doc whose (module, doc_type) pair has no routing rule. Action 'route'
 * supplies a re-targeted module/doc_type pair to retry route resolution;
 * 'reject' transitions the doc to 'failed'.
 */
export const RoutingResolutionSignalSchema = z.discriminatedUnion('action', [
  z.object({
    action:   z.literal('route'),
    module:   z.string(),
    docType:  z.string(),
  }),
  z.object({
    action: z.literal('reject'),
    reason: z.string().optional(),
  }),
]);
export type RoutingResolutionSignal = z.infer<typeof RoutingResolutionSignalSchema>;
