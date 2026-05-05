// Slice 58C — extraction strategy contract.
//
// The doc-service classify+extract phase loop dispatches each (module,
// doc_type) pair to a per-module activity that produces a strategy
// output. The activity is invoked across Temporal task queues — the
// doc-service workflow proxies it on whichever queue the strategy
// row in cip_documents.extraction_strategies says (e.g. cert lives on
// `cip-hr-tasks`, future training docs would live on a new queue).
//
// Both schemas are versioned implicitly by their position here; the
// strategy registry config_json may add per-strategy parameters that
// extend the input shape via passthrough.
//
// Invariant: every strategy implementation MUST `.parse()` its input
// (Non-Negotiable #5) and `.parse()` its output before returning.

import { z } from 'zod';

export const ExtractionInputSchema = z.object({
  tenantId:          z.string().uuid(),
  documentId:        z.string().uuid(),
  module:            z.string(),
  docType:           z.string(),
  ocrText:           z.string(),
  // Storage coordinates — strategies fetch S3 directly with their own
  // service credentials (kickoff correction #5: no presigning helper).
  s3Bucket:          z.string(),
  s3Key:             z.string(),
  // Generic features (page count, OCR confidence, etc.) for strategies
  // that want the upstream context. Open record so each strategy can
  // pull what it needs without forcing the slice to enumerate keys.
  genericFeatures:   z.record(z.unknown()),
  sensitivityTier:   z.enum(['public', 'internal', 'confidential', 'restricted']),
  uploaderHintText:  z.string().optional(),
  // Per-strategy config_json from the registry row. Strategies declare
  // how they consume it — typically things like model alias overrides
  // or tunable thresholds.
  config:            z.record(z.unknown()).optional(),
});
export type ExtractionInput = z.infer<typeof ExtractionInputSchema>;

export const ExtractionOutputSchema = z.object({
  // The structured fields the strategy extracted. Shape is type-specific
  // (cert has holderName/expiryDate/...; future modules differ).
  fields:               z.record(z.unknown()),
  extractionConfidence: z.number().min(0).max(1),
  // Strategy-supplied evidence: model name, prompt version, raw response,
  // confidence factors. Surfaces in audit_events.payload and HITL cards.
  evidence:             z.record(z.unknown()),
});
export type ExtractionOutput = z.infer<typeof ExtractionOutputSchema>;

/**
 * Cross-service activity surface — the doc-service workflow type-only-
 * imports this and feeds it to `proxyActivities<ExtractionActivities>({
 * taskQueue: '<strategy queue>' })`. Each module package implements the
 * methods it owns and registers them on its own worker; doc-service
 * never imports the impls.
 *
 * Convention: activity name = `extract_${module}_features`. Future
 * doc_type-specific variants can be added as additional methods.
 */
export interface ExtractionActivities {
  extractCertFeaturesActivity(input: ExtractionInput): Promise<ExtractionOutput>;
}
