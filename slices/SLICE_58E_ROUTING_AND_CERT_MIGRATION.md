# Slice 58E — routing handoff + cert workflow as Route-A consumer

> **Why this exists:** 58D leaves docs at `awaiting_routing` with
> module + doc_type + subject all set. 58E does the handoff:
> queries `document_routing_map`, starts the downstream module
> workflow, transitions the doc to `routed`, and waits for the
> module to call back with success/failure.
>
> The cert workflow is rewritten as a Route-A consumer (locked
> decision): `processDocument(documentId, ...features)` activity in
> the cert module replaces the old fetch+preClassify+vision steps.
> The legacy bot fast-path (`process_document` MCP tool, cert-only
> workflow start) is removed. After this slice the cert flow runs
> end-to-end through the new doc pipeline.

---

## Files in scope

```
packages/document-service/src/modules/ingest/                        (continues)
├── workflows/document-processing.workflow.ts                        MOD (add route phase + routingResolution signal)
├── activities/
│   ├── route-document.activity.ts                                   NEW (queries routing_map, starts module workflow, awaits callback)
│   ├── handle-module-callback.activity.ts                           NEW (module workflow signals back; updates docs.downstream_module_record_id)
│   └── index.ts                                                     MOD

packages/document-service/src/modules/routing/                       NEW directory
├── mcp-tools/
│   ├── routing-map-list.tool.ts                                     NEW (admin: see all routes)
│   ├── routing-map-set.tool.ts                                      NEW (admin: add/update a (module, doc_type) → workflow row)
│   └── index.ts                                                     NEW

packages/hr-service/src/modules/certifications/                      MOD
├── activities/
│   ├── process-document.activity.ts                                 NEW (the Route-A entry — implements ProcessDocumentInput contract)
│   ├── revoke-for.activity.ts                                       NEW (revokeFor; placeholder for 58F use; throws 'not implemented' until then)
│   ├── index.ts                                                     MOD (export both)
│   ├── fetch-document.activity.ts                                   DELETED (no longer needed — features come pre-extracted)
│   ├── pre-classify-cert.activity.ts                                DELETED
│   ├── run-vision-agent.activity.ts                                 DELETED (logic moved to 58C's extract-cert-features.activity.ts)
│   ├── extract-cert-features.activity.ts                            (from 58C — kept; this is what doc-service calls)
│   ├── match-employee.activity.ts                                   MOD (now takes pre-resolved subjectEmployeeId; deleted fuzzy-match path)
│   └── match-cert-definition.activity.ts                            (kept; runs against extracted_features now)
├── workflows/certification-processing.workflow.ts                   MOD (rewritten as Route-A consumer; takes ProcessDocumentInput; no fetch/preClassify/vision)
└── mcp-tools/process-document.ts                                    DELETED (legacy entry — bot now goes through doc-service)

packages/teams-bot/src/bot.ts                                        MOD (delete legacy file fast-path that called process_document; bot now ALWAYS routes uploads through document_process)

packages/hr-service/src/db/migrations/
└── 039_routing_map_seed.sql                                         NEW (seeds default cert routing rule for all existing tenants)

packages/hr-service/src/services/permission-catalog-seed.ts          MOD (add documents.admin.routing_map.write to the catalog)

scripts/provision-tenant.sh                                          MOD (after tenant provisioning, copy default routing_map rows for the new tenant)
```

---

## Hard rules

1. **Cert workflow stops doing OCR/extraction.** It receives
   `extractedFeatures` and `subjectEmployeeId` as input. If you find
   yourself reaching for `documentBase64` or `runVisionAgent` in
   58E's cert workflow, stop and re-read the locked decision
   (Route A: cert is downstream, not parallel).
2. **Bot's legacy file fast-path is removed.** The block at
   `packages/teams-bot/src/bot.ts:202-219` (cert-only fast-path)
   becomes the doc-service `document_process` call. Cert behavior
   should still work end-to-end — verified by the existing cert
   integration tests (which must keep passing).
3. **`documents.cert_legacy_path` tunable is set to `false`** as
   part of this slice's migration. After 58E, the tunable is
   meaningless and is removed in a follow-up cleanup.
4. **Module workflow IDs follow the existing convention**:
   `CertProcess-${tenantId}-${certSubmissionId}` for cert (unchanged).
   The new `documentId` ↔ `certSubmissionId` correlation is stored
   on `documents.downstream_module_record_id`.
5. **Routing decisions are logged to audit_events** with
   `event_type='routed'` and payload including the resolved row
   from `document_routing_map`.
6. **No code in routing tries multiple downstreams.** One doc → one
   downstream workflow. Reclassification (58F) is the path to "this
   was misclassified, route somewhere else."

---

## Workflow additions

```typescript
// document-processing.workflow.ts, after 58D's subject step:

const routingSignal = defineSignal<[RoutingResolutionSignal]>('routingResolution');
let routingSignaled: RoutingResolutionSignal | undefined;
setHandler(routingSignal, (s) => { routingSignaled = s; });

await progress('route', 'started');
const routing = await routeDocumentActivity({
  tenantId, documentId,
  module: cls.module,
  docType: cls.docType,
});

if (!routing.matched) {
  // No routing rule for (module, doc_type) — admin queue
  await transitionStateActivity({ tenantId, documentId, to: 'hitl_admin_queue', preHitlState: 'awaiting_routing', reason: 'no_routing_rule' });
  await condition(() => routingSignaled !== undefined);
  if (routingSignaled.action === 'reject') {
    await transitionStateActivity({ tenantId, documentId, to: 'failed' });
    return;
  }
  // 'route' action: re-run the route phase with admin-supplied module/docType
  // (recursive call would be unsafe in Temporal; instead loop with reassignment)
}

// Start downstream module workflow on its task queue
const downstream = await startDownstreamWorkflowActivity({
  tenantId, documentId,
  taskQueue: routing.taskQueue,
  workflowType: routing.workflowType,
  input: {
    tenantId, documentId,
    uploaderEmployeeId: input.uploaderEmployeeId,
    subjectEmployeeId: subjectId!,                       // resolved in 58D
    docType: cls.docType,
    extractedFeatures: extracted.fields,
    genericFeatures: generic,
    sensitivityTier: sens.tier,
    s3Bucket: BUCKET, s3Key,
    actorContext: extractActorContextForForwarding(input),
  } as ProcessDocumentInput,
});

await transitionStateActivity({ tenantId, documentId, to: 'routed', downstreamWorkflowId: downstream.workflowId });
await progress('route', 'completed', { downstreamWorkflowId: downstream.workflowId });

// Wait for module callback (via signal OR polling — design: signal)
const callbackSignal = defineSignal<[ModuleCallbackSignal]>('moduleCallback');
let callback: ModuleCallbackSignal | undefined;
setHandler(callbackSignal, (s) => { callback = s; });
await condition(() => callback !== undefined);

await persistDownstreamRecordActivity({ tenantId, documentId, moduleRecordId: callback.moduleRecordId, status: callback.status });
await transitionStateActivity({ tenantId, documentId, to: 'archived' });
await progress('archive', 'completed', { moduleRecordId: callback.moduleRecordId });
```

---

## Cert workflow rewrite (Route A)

`packages/hr-service/src/modules/certifications/workflows/certification-processing.workflow.ts`:

```typescript
import { proxyActivities, defineSignal, setHandler, condition } from '@temporalio/workflow';
import type { ProcessDocumentInput } from '@cip/shared';
import type { HITLDecisionSignal } from '@cip/shared';
import type * as activities from '../activities/index.js';

const {
  validateExtractionActivity,
  matchCertDefinition,
  matchEmployee,                  // signature changed: now takes a pre-resolved subjectEmployeeId for verification only
  notifyHitlActivity,
  persistCertActivity,
  publishCertProcessedActivity,
  signalDocumentServiceCallback,  // NEW — calls back to doc-service workflow with moduleRecordId
} = proxyActivities<typeof activities>({ startToCloseTimeout: '30s', retry: { maximumAttempts: 3 } });

export const hitlDecisionSignal = defineSignal<[HITLDecisionSignal]>('hitlDecision');

export async function CertificationProcessingWorkflow(input: ProcessDocumentInput): Promise<void> {
  // Workflow ID pattern: {workflowType}-{tenantId}-{entityId}
  // workflowId: `CertProcess-${input.tenantId}-${certSubmissionId}`
  const { tenantId, documentId, subjectEmployeeId, extractedFeatures } = input;
  const certSubmissionId = await createCertSubmissionRow({ tenantId, documentId, subjectEmployeeId });

  let hitlDecision: HITLDecisionSignal | undefined;
  setHandler(hitlDecisionSignal, (decision) => { hitlDecision = decision; });

  // No fetch/preClassify/vision — features come from doc-service.
  await validateExtractionActivity({ tenantId, certSubmissionId, extractedFeatures });

  const [employeeMatch, certMatch] = await Promise.all([
    matchEmployee({ tenantId, certSubmissionId, subjectEmployeeId, extractedFeatures }),
    matchCertDefinition({ tenantId, certSubmissionId, extractedFeatures }),
  ]);

  // employeeMatch is now a verification: confidence == 1.0 if subject was already resolved
  const needsHitl =
    input.extractedFeatures.overallConfidence < 0.85 ||
    certMatch.confidence < 0.7;
  // employee ambiguity is no longer possible — doc-service resolved it before we got here

  if (needsHitl) {
    await notifyHitlActivity({ tenantId, certSubmissionId, hitlReasonCode: 'low_confidence' });
    await condition(() => hitlDecision !== undefined, '7 days');
  }

  const { certificationId } = await persistCertActivity({
    tenantId, certSubmissionId,
    extractedFeatures,
    matchedEmployeeId: subjectEmployeeId,
    certDefId: certMatch.certDefId,
  });

  await publishCertProcessedActivity({ tenantId, certificationId, employeeId: subjectEmployeeId, certSubmissionId });

  // Tell doc-service we're done so the doc transitions to 'archived'.
  await signalDocumentServiceCallback({
    tenantId, documentId,
    moduleRecordId: certificationId,
    status: 'accepted',
  });
}
```

The cert workflow shrinks substantially — three steps fewer. Keeps
the HITL signal pattern for cert-specific low-confidence cases (like
"we extracted 0.6 confidence on the cert number"). Subject ambiguity
HITL is gone because doc-service already resolved it.

---

## Bot legacy removal

In `packages/teams-bot/src/bot.ts:202-219`, replace the cert-only
fast-path:

```typescript
// REMOVED: cert-only fast-path
//   if (fileAttachments.length > 0) {
//     for (const file of fileAttachments) {
//       const key = await downloadToObjectStore(file, ctx);
//       const result = await executeTool('process_document', { objectStoreKey: key }, ctx);
//       ...
//     }
//   }

// NEW: every upload goes through document-service
if (fileAttachments.length > 0) {
  for (const file of fileAttachments) {
    const buffer = await downloadAttachmentToBuffer(file);
    const result = await executeTool('document_process', {
      fileBase64: buffer.toString('base64'),
      fileName: file.name ?? 'upload',
      mimeType: guessMimeType(file.name ?? '', file.contentType),
      hintText: text || undefined,
      sourceMessageId: context.activity.id,
      conversationId: context.activity.conversation?.id,
    }, ctx);
    await renderResponse(context, result);
  }
  return;
}
```

`downloadToObjectStore` from `file-handler.ts` is deleted (its
S3 PutObject responsibility moves to doc-service). Replaced with
`downloadAttachmentToBuffer` (just the Teams CDN fetch).

---

## Default routing map seed

`039_routing_map_seed.sql`:

```sql
-- Seed cert routing for the placeholder global tenant
INSERT INTO cip_documents.document_routing_map (tenant_id, module, doc_type, task_queue, workflow_type)
SELECT id, 'certificate', '*', 'cip-hr-tasks', 'CertificationProcessingWorkflow'
FROM cip_hr.tenants
ON CONFLICT (tenant_id, module, doc_type) DO NOTHING;
```

`provision-tenant.sh` gains a step to copy these defaults for any
new tenant created post-58E.

---

## Acceptance criteria

1. Upload a CPR cert PDF in Teams → progress messages show
   `scan ✓ → features ✓ → sensitivity ✓ → classify ✓ → extract ✓
   → subject ✓ → route ✓ → archive ✓`. Final card: cert summary.
2. The cert appears in `cert_submissions` and `certifications`
   tables exactly as it did pre-58E.
3. `documents.lifecycle_state='archived'` and
   `documents.downstream_module_record_id = certificationId`.
4. Cert integration tests (whatever existed pre-58E) all pass —
   the externally-observable cert flow is unchanged.
5. Bot logs show `mode=document_process` (not `mode=file` cert path).
6. Upload a non-cert (e.g. a random PDF) → after 58C's HITL queue
   admin labels it → routing has no rule → admin uses
   `documents_hitl_route_to_module` → workflow advances.
7. The legacy `process_document` MCP tool no longer registered on
   hr-service (verified by listing tools through the bot — only
   `document_process` on doc-service for upload).

---

## Forward refs

- 58F adds the reclassify path: uses `revokeFor` activity (stub
  added in 58E's cert module, throws 'not implemented' until 58F).
- 58G adds the soft/hard-purge cron.
- 58H replaces the LLM classifier (58C) with a per-tenant sklearn
  classifier as training data accumulates.
- 58I adds cert template-and-compare.
