# Slice 58C — classification + per-type extraction strategy

> **Why this exists:** 58B leaves docs at `classifying`
> with generic features and sensitivity but no module/doc_type.
> 58C picks them up, classifies (LLM, Langfuse-hosted prompt,
> input = generic features + OCR + uploader hint), and routes
> through a per-type extraction strategy. The cert strategy
> delegates to the existing `runVisionAgentActivity` / vision-agent
> pipeline — keeping the slice cert-only as the user locked, but
> behind an interface that future modules can plug into.
>
> After 58C: doc has `module + doc_type + classification_confidence
> + extracted_features` populated. Workflow halts at
> `awaiting_subject` (58D handles that).

---

## Files in scope

```
packages/document-service/src/modules/ingest/                        (continues)
├── workflows/document-processing.workflow.ts                        MOD (add classify + extract phases)
├── activities/
│   ├── classify-document.activity.ts                                NEW (LLM + threshold)
│   ├── run-extraction-strategy.activity.ts                          NEW (dispatch by doc_type → strategy)
│   └── index.ts                                                     MOD

packages/document-service/src/extraction/                            NEW directory
├── registry.ts                                                      NEW (per-tenant strategy lookup; DB-backed; NOT a code map)
├── strategy-interface.ts                                            NEW (re-exports from @cip/shared)
└── strategies/
    └── certificate.strategy.ts                                      NEW (delegates to hr-service activities via NATS request-reply)

packages/shared/src/types/extraction-strategy.ts                     NEW (ExtractionStrategy interface)
packages/shared/src/index.ts                                         MOD

packages/hr-service/src/modules/certifications/activities/
└── extract-cert-features.activity.ts                                NEW (wraps existing vision-agent invocation; callable by name from doc-service)

packages/hr-service/src/db/migrations/
└── 038_extraction_strategy_registry.sql                             NEW (cip_documents.extraction_strategies table)

# Langfuse-hosted prompts (deployed via Langfuse UI before testing):
#   bot.documents.classify         v1   (classifier rubric)
#   bot.documents.classify_evidence v1  (lays out the catalog of doc_types per-tenant)
```

---

## Hard rules

1. **Strategy registry is a DB table, not a code map** (per memory rule).
   `cip_documents.extraction_strategies (tenant_id, module, doc_type,
   strategy_name, config_json)`. The doc-service `registry.ts` queries
   it; never hard-codes a strategy lookup.
2. **Cross-service strategy invocation is via Temporal task queue
   handoff, not direct HTTP.** Doc-service workflow starts the cert
   strategy by signaling/starting an activity on `cip-hr-tasks`. Avoids
   the doc-service holding hr-service permissions.
3. **Classification prompt is Langfuse-hosted** (per memory rule —
   prompts in Langfuse, tool descriptions in code).
4. **Classifier output Zod-parsed** before persistence. (Non-Negotiable #5.)
5. **Confidence threshold is a tunable**: `documents.classify_confidence_threshold`,
   default `0.75`. Below threshold → transition to `hitl_admin_queue`
   with `pre_hitl_state='classifying'`.

---

## Workflow additions

```typescript
// document-processing.workflow.ts, after 58B's sensitivity step:

await progress('classify', 'started');
const cls = await classifyDocumentActivity({
  tenantId, documentId,
  ocrText: generic.ocrText,
  fileName: generic.fileName,
  genericFeatures: generic,
  uploaderHintText: input.uploaderHintText,
  sensitivityTier: sens.tier,
});
await progress('classify', 'completed', { module: cls.module, docType: cls.docType, confidence: cls.confidence });

if (cls.confidence < tunables.classify_confidence_threshold) {
  // park in HITL queue; 58D's admin tools resolve
  await transitionStateActivity({ tenantId, documentId, to: 'hitl_admin_queue', preHitlState: 'classifying', reason: 'low_classification_confidence' });
  return;
}

await progress('extract', 'started');
const extracted = await runExtractionStrategyActivity({
  tenantId, documentId, module: cls.module, docType: cls.docType,
  strategyContext: { genericFeatures: generic, sensitivityTier: sens.tier, uploaderHintText: input.uploaderHintText },
});
await progress('extract', 'completed', { fieldCount: Object.keys(extracted.fields).length });

// Transition → 'awaiting_subject' for 58D.
```

---

## Activity contracts

### `classifyDocumentActivity`

```
Input:  { tenantId, documentId, ocrText, fileName, genericFeatures, uploaderHintText?, sensitivityTier }
Output: { module: string, docType: string, confidence: number, alternatives: Array<{module, docType, confidence}>, evidence: Record<string, unknown> }

1. Load Langfuse prompt 'bot.documents.classify' (current version).
2. Load tenant's enabled doc_type catalog from extraction_strategies table.
3. Call LiteLLM /chat with system prompt + user prompt = {ocrText (truncated), fileName, hintText, genericFeatures, sensitivityTier}.
4. Expect structured JSON: { module, doc_type, confidence, alternatives, reasoning }.
5. Zod-parse; persist on documents row (module, doc_type, classification_confidence, classification_evidence).
6. Audit: classified, payload includes alternatives + reasoning.
```

### `runExtractionStrategyActivity`

```
Input:  { tenantId, documentId, module, docType, strategyContext }
Output: { fields: Record<string, unknown>, extractionConfidence: number, evidence }

1. SELECT FROM cip_documents.extraction_strategies WHERE tenant_id=$1 AND module=$2 AND doc_type=$3 (with fallback to (module,'*')).
2. For strategy_name='certificate':
   - Use Temporal client to start a child workflow OR invoke the cert-extraction
     activity registered on cip-hr-tasks queue.
   - Pass: tenantId, documentId, ocrText, presigned-S3-URL (5 min TTL).
3. Receive ExtractionResult { fields, confidence, evidence }.
4. Zod-parse; UPDATE documents SET extracted_features=$fields, extraction_confidence=$confidence.
5. Audit: state_transition, payload={fields_count, confidence}.
```

---

## Strategy interface (`@cip/shared`)

```typescript
// packages/shared/src/types/extraction-strategy.ts
export const ExtractionInputSchema = z.object({
  tenantId: z.string().uuid(),
  documentId: z.string().uuid(),
  module: z.string(),
  docType: z.string(),
  ocrText: z.string(),
  s3PresignedUrl: z.string().url(),
  genericFeatures: z.record(z.unknown()),
  sensitivityTier: z.enum(['public','internal','confidential','restricted']),
  uploaderHintText: z.string().optional(),
});
export type ExtractionInput = z.infer<typeof ExtractionInputSchema>;

export const ExtractionOutputSchema = z.object({
  fields: z.record(z.unknown()),
  extractionConfidence: z.number().min(0).max(1),
  evidence: z.record(z.unknown()),
});
export type ExtractionOutput = z.infer<typeof ExtractionOutputSchema>;

// Each module implements this as an activity registered on its own task queue.
// The activity NAME convention: `extract_${module}_${docType}`. Wildcard variants
// (e.g. `extract_certificate_*`) are matched at registry resolution time.
```

---

## Cert strategy (the only one in this slice)

In `packages/hr-service/src/modules/certifications/activities/extract-cert-features.activity.ts`:

```typescript
export async function extractCertFeaturesActivity(input: ExtractionInput): Promise<ExtractionOutput> {
  const validated = ExtractionInputSchema.parse(input);

  // Reuse existing vision agent. Today it expects a base64 doc; fetch via presigned URL.
  const docBase64 = await fetchPresignedToBase64(validated.s3PresignedUrl);
  const certTypeHint = inferCertTypeHint(validated.docType);   // e.g. 'cpr', 'first_aid'

  const visionExtraction = await runVisionAgent({
    tenantId: validated.tenantId,
    submissionId: validated.documentId,                        // reused as correlation id
    employeeId: 'unknown',                                     // subject resolution happens in 58D
    documentBase64: docBase64,
    certTypeHint,
  });

  return ExtractionOutputSchema.parse({
    fields: visionExtraction.fields,
    extractionConfidence: visionExtraction.overallConfidence,
    evidence: { source: 'vision-agent', model: visionExtraction.model, raw: visionExtraction.raw },
  });
}
```

This is the seam: existing cert vision-agent code is untouched.
The new activity adapts its input/output to the strategy contract.
58E will rewrite `CertificationProcessingWorkflow` to consume the
output of this activity instead of running its own vision-agent
step.

---

## DB seed for cert strategy

```sql
INSERT INTO cip_documents.extraction_strategies (tenant_id, module, doc_type, strategy_name, config_json) VALUES
  -- '*' tenant_id is the catchall; per-tenant overrides come later
  ('00000000-0000-0000-0000-000000000000', 'certificate', '*', 'extract_certificate_default', '{"task_queue":"cip-hr-tasks","activity_name":"extractCertFeaturesActivity"}')
ON CONFLICT (tenant_id, module, doc_type) DO NOTHING;
```

Tenants without an override use the catchall row. Provisioning-tenant
script gains a step in 58E that copies the catchall row for the new tenant.

---

## Acceptance criteria

1. Typecheck passes across packages.
2. Upload a real CPR cert PDF in Teams → progress shows `classify ✓ certificate.cpr (0.89 conf)` then `extract ✓ 4 fields` → doc reaches `awaiting_subject`. Cert vision-agent unchanged behaviorally.
3. Upload an obviously non-cert (e.g. random text PDF) → low confidence → doc lands in `hitl_admin_queue` with `pre_hitl_state='classifying'`. Visible in admin queue (58D adds the queue UX; 58C verifies the state is set).
4. `cip_documents.extraction_strategies` populated with the `'*' / certificate / *` catchall.
5. Langfuse trace shows `bot.documents.classify` prompt invocation as a generation span under the workflow trace.

---

## Forward refs

- 58D resolves the subject (uploader hint + content NER + HITL pickcard).
- 58E adds routing — once `awaiting_routing`, the cert workflow is started with the already-extracted features (Route A).
