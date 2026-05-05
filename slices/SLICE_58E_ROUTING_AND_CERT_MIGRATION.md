# Slice 58E — routing handoff + cert workflow as Route-A consumer

> **Drift reconciliation (2026-05-05) — read before implementing.**
> Several sections of this doc were drafted before 58D-A, 58D-B, and
> the Q4 default-policy patch landed. Reality has shifted; the
> implementer should follow this header where it conflicts with the
> body below.
>
> **Already shipped (NOT in 58E scope anymore):**
> - **Bot legacy fast-path removal** — already shipped in commit
>   `d9b847b`. `packages/teams-bot/src/bot.ts` already streams every
>   upload through doc-service's `document_process`. The "Bot legacy
>   removal" section below is obsolete; do not re-modify the bot.
> - **Cert workflow's subject-resolution path** — already replaced
>   in 58D-B (commit `dbd33af`) with `startChild('MatchPersonWorkflow')`.
>   The Route-A rewrite must PRESERVE this child-workflow call;
>   it does not introduce it.
> - **`rejectCertSubmissionActivity`** — already added in 58D-B.
>   Route-A keeps using it for the `submission_status='failed'`
>   side-effect; the `signalDocumentServiceCallback({status:'rejected'})`
>   call additionally informs doc-service.
>
> **`ProcessDocumentInput` precise shape** (for the new
> `@cip/shared/types/process-document.ts`):
>
> ```typescript
> export const ProcessDocumentInputSchema = z.object({
>   tenantId:             z.string().uuid(),
>   documentId:           z.string().uuid(),
>   uploaderEmployeeId:   z.string(),                     // AAD object id
>   uploaderHintText:     z.string().optional(),
>   conversationId:       z.string().optional(),
>   docType:              z.string(),
>   extractedFeatures:    z.record(z.unknown()),          // = ExtractionOutput.fields from 58C
>   extractionConfidence: z.number().min(0).max(1),       // top-level, NOT inside extractedFeatures
>   genericFeatures:      z.record(z.unknown()),          // ocrText, fileName, mimeType, pageCount
>   sensitivityTier:      z.enum(['public','internal','confidential','restricted']),
>   s3Bucket:             z.string(),
>   s3Key:                z.string(),
>   actorContext:         z.record(z.unknown()),          // forwarding shape
> });
> ```
>
> The cert workflow snippet below references
> `extractedFeatures.overallConfidence` — that's wrong. Use the
> top-level `extractionConfidence` field. `extractedFeatures` is the
> generic per-doc-type field bag (e.g. `holderName`, `holderEmail`,
> `certNumber`, `expiryDate` for cert).
>
> **MatchPerson policy in cert (post-Q4)**: drop the explicit
> `policy: { onNoMatch: 'fail', onAmbiguous: 'uploader_pickcard' }`
> object below; either omit it (use schema defaults
> `onNoMatch='admin_queue'`, `onAmbiguous='uploader_pickcard'`) or
> set it to match what 58D-B currently does (matches default).
> Aligns with the post-Q4 "no match → admin HITL" decision.
>
> **`MatchPersonWorkflow` type-only import path**: `'@cip/shared'`
> doesn't export the workflow type — only its input/output schemas.
> Use the same local path 58D-B did:
> `import type { MatchPersonWorkflow } from '../../people/workflows/match-person.workflow.js';`
> Cert workflow already does this; the Route-A rewrite preserves it.
>
> **NEW activities 58E adds (spec'd here, not in body):**
> - `createCertSubmissionRow` (~25 LOC) — Route-A entry. Inserts
>   `cert_submissions` row from `ProcessDocumentInput`; returns
>   `{ certSubmissionId }`. Today the row is created externally by
>   the bot's `process_document` MCP tool; in Route-A the cert
>   workflow creates it.
> - `signalDocumentServiceCallback` (~30 LOC) — sends
>   `moduleCallback` signal to the doc-service workflow handle
>   (`DocumentProcess-${tenantId}-${documentId}`) with
>   `{ moduleRecordId, status: 'accepted' | 'rejected', reason? }`.
> - `routeDocumentActivity` (~70 LOC, doc-service side) — queries
>   `document_routing_map`, returns `{ matched: bool, taskQueue?,
>   workflowType? }` plus the `(module, doc_type)` row context.
> - `startDownstreamWorkflowActivity` (~50 LOC, doc-service side) —
>   uses `createTemporalClient` to start the matched workflow on its
>   queue, returns `{ workflowId }`.
> - `handleModuleCallbackActivity` (~25 LOC, doc-service side) —
>   updates `documents.downstream_module_record_id`,
>   `downstream_workflow_id` from the callback payload.
> - `persistDownstreamRecordActivity` (~25 LOC, doc-service side) —
>   final write before lifecycle → `archived` (the slice body
>   references it; pin it as a real activity here).
>
> **Tunable rename — verified scope** (`lg.extract_*` →
> `documents.extract_*`):
> Already-seeded `lg.*` tunables to migrate (per
> `041_extraction_tunables.sql`):
> `lg.extract_token_budget`, `lg.cert_text_extraction_min_chars`,
> `lg.extract_image_ocr_model`, `lg.extract_pdf_text_first`,
> `lg.extract_pdf_text_min_chars`, `lg.extract_office_image_render`,
> `lg.extractor_db_timeout_ms`. Backwards-compatible: insert
> `documents.*` rows alongside, update the loader to read new keys
> first then fall back to old, drop `lg.*` rows after one release.
> `lg.cert_text_extraction_min_chars` renames to
> `documents.cert_text_extraction_min_chars` (still cert-scoped but
> on the documents prefix; alternative `documents.extract_text_min_chars`
> if you want it module-agnostic — pick one and document why).
>
> **Phase 2 `mime_filter` column on `extraction_strategies`**:
> ALTER TABLE adds `mime_filter TEXT`, NULLABLE.
> `extraction/registry.ts:resolveStrategy()` widens the SELECT and
> adds `mime_filter` to the specificity scoring (exact MIME class
> match > NULL match). 58C-FIX's `classifyMime()` already returns
> the canonical class names (`'pdf' | 'image' | 'plain_text' | 'docx'
> | 'xlsx' | 'pptx' | 'unsupported'`); the registry stores those
> exact strings. Backwards-compatible: existing rows with
> `mime_filter=NULL` continue matching every doc.
>
> **Alias-resolver consolidation** (Option B, already-decided):
> already documented in the body's preamble; the implementer
> consolidates both copies into `@cip/shared/clients/litellm-alias-resolver.ts`.
> Test set moves to `packages/shared/test/`.


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
>
> **Also folded in (added 2026-05-05):** registry-level MIME
> routing — phase 2 of the MIME-aware extraction work whose phase
> 1 (per-MIME extractors in doc-service) ships in slice 58C-FIX.
> Adds `mime_filter` column on `extraction_strategies` so a tenant
> can register different `strategy_name` rows per
> `(module, doc_type, mime_class)`. Resolver matches `mime_filter`
> against the doc's normalized MIME class. Backwards compatible:
> rows with `mime_filter = NULL` match any MIME (current default).
>
> **Tunable namespace rename (added 2026-05-05):** 58C-FIX
> seeded extraction tunables under the `lg.*` prefix
> (`lg.extract_token_budget`, `lg.cert_text_extraction_min_chars`,
> `lg.extract_image_ocr_model`, `lg.extract_pdf_text_first`,
> `lg.extract_office_image_render`, plus `lg.cert_text_extraction_min_chars`).
> The `lg.*` prefix belongs to bot-LangGraph runtime tunables;
> doc-service tunables otherwise use `documents.*`. 58E renames
> them via backwards-compatible migration: insert new
> `documents.extract_*` rows, update doc-service tunables loader
> to read the new keys (falling back to `lg.*` for one release),
> then drop `lg.*` rows. Any `lg.cert_*` value stays under `lg.*`
> only if it's truly bot-LangGraph-scoped — otherwise renames to
> `documents.cert_*`.
>
> **Alias-resolver consolidation (added 2026-05-05):** today
> `resolveAlias` exists in two near-identical implementations —
> `packages/hr-service/src/services/alias-resolver.ts` (DB-direct
> against `cip_hr.routing_rules` + `tenant_settings.routing_overrides`,
> 79 LOC) and `packages/teams-bot/src/intent/alias-resolver.ts`
> (HTTP against hr-service's existing `GET /admin/routing-rules`,
> 80 LOC). 58E collapses both into a single shared HTTP variant
> at `@cip/shared/clients/litellm-alias-resolver.ts`, since the
> HTTP path is the only one that works across the doc-service
> DB split (and across any future non-HR consumer). hr-service
> activities accept one HTTP self-call per cache miss (5-min TTL
> per pod per tenant-service pair) — net cost is negligible and
> the implementation drift goes away. The earlier deferral was
> right that nothing forced the move; it was wrong that the
> cross-DB framing made it impossible. The bot's HTTP variant
> already proved the path. doc-service does not become a consumer
> in this slice (it still hardcodes `cip-classifier`, `cip-vision`,
> etc.) — that ships when a tenant first asks for an override.

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
│   ├── match-employee.activity.ts                                   (unchanged from 58D-B — thin shim that starts MatchPersonWorkflow as a child workflow; kept under this name for Temporal worker registration continuity)
│   └── match-cert-definition.activity.ts                            (kept; runs against extracted_features now)
├── workflows/certification-processing.workflow.ts                   MOD (rewritten as Route-A consumer; takes ProcessDocumentInput; no fetch/preClassify/vision)
└── mcp-tools/process-document.ts                                    DELETED (legacy entry — bot now goes through doc-service)

packages/teams-bot/src/bot.ts                                        MOD (delete legacy file fast-path that called process_document; bot now ALWAYS routes uploads through document_process)

packages/hr-service/src/db/migrations/
└── 039_routing_map_seed.sql                                         NEW (seeds default cert routing rule for all existing tenants)

packages/hr-service/src/services/permission-catalog-seed.ts          MOD (add documents.admin.routing_map.write to the catalog)

scripts/provision-tenant.sh                                          MOD (after tenant provisioning, copy default routing_map rows for the new tenant)

# ─── Alias-resolver consolidation ──────────────────────────────────
packages/shared/src/clients/litellm-alias-resolver.ts                NEW (HTTP variant; merges the bot's resolver into shared)
packages/shared/src/index.ts                                         MOD (re-export resolveAlias + types)

packages/hr-service/src/services/alias-resolver.ts                   DELETED (replaced by shared HTTP variant)
packages/teams-bot/src/intent/alias-resolver.ts                      DELETED (replaced by shared HTTP variant)

# Caller import updates (no logic change at the call sites):
packages/hr-service/src/modules/certifications/activities/match-employee.activity.ts          MOD
packages/hr-service/src/modules/certifications/activities/match-cert-definition.activity.ts   MOD
packages/hr-service/src/modules/certifications/activities/extract-cert-features.activity.ts   MOD
packages/hr-service/src/modules/certifications/agents/vision-agent/nodes.ts                   MOD
packages/teams-bot/src/langgraph/nodes/triage.ts                                              MOD
packages/teams-bot/src/langgraph/nodes/plan.ts                                                MOD
packages/teams-bot/src/langgraph/nodes/summarize.ts                                           MOD
# (Note: match-employee.activity.ts is also rewritten elsewhere in this slice — keep
#  the alias-resolver import update aligned with that rewrite.)
```

---

## Hard rules

1. **Cert workflow stops doing OCR/extraction.** It receives
   `extractedFeatures` (and uploader hint, etc.) as input but
   **NOT** `subjectEmployeeId` — subject resolution is owned by the
   cert workflow itself, via `MatchPersonWorkflow` (58D-A child
   workflow), already integrated by 58D-B. If you find yourself
   reaching for `documentBase64` or `runVisionAgent` in 58E's cert
   workflow, stop and re-read the locked decision (Route A: cert is
   downstream, not parallel).
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
7. **Alias-resolver becomes HTTP-only and lives in `@cip/shared`.**
   No service may keep its own copy. The shared module is the only
   consumer of `GET /admin/routing-rules`. hr-service's
   `db/queries/routing-rules.ts` (the data layer behind the
   endpoint) stays put — only the resolver wrapper consolidates.
   Backwards-compatible: the FALLBACK_ALIAS (`'cip-chat'`), 5-min
   per-tenant cache TTL, and the resolution order
   (tenant override → global rule → fallback) MUST match the
   pre-58E behavior exactly. Verify with the existing alias-resolver
   tests (which move to `packages/shared/test/`).

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

// Start downstream module workflow on its task queue. ProcessDocumentInput
// does NOT include subjectEmployeeId — module workflows resolve their own
// subject via MatchPersonWorkflow (58D-A) when the domain requires it.
const downstream = await startDownstreamWorkflowActivity({
  tenantId, documentId,
  taskQueue: routing.taskQueue,
  workflowType: routing.workflowType,
  input: {
    tenantId, documentId,
    uploaderEmployeeId: input.uploaderEmployeeId,
    uploaderHintText:   input.uploaderHintText,
    conversationId:     input.conversationId,
    docType:            cls.docType,
    extractedFeatures:  extracted.fields,
    genericFeatures:    generic,
    sensitivityTier:    sens.tier,
    s3Bucket: BUCKET, s3Key,
    actorContext:       extractActorContextForForwarding(input),
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
import { proxyActivities, startChild, defineSignal, setHandler, condition, ApplicationFailure } from '@temporalio/workflow';
import type { ProcessDocumentInput, MatchPersonInput, MatchPersonOutput } from '@cip/shared';
import type { HITLDecisionSignal } from '@cip/shared';
import type * as activities from '../activities/index.js';
// MatchPersonWorkflow is referenced as a TYPE only — the cert worker registers
// no implementation; it lives on the same hr-service worker pool and is started
// as a child workflow on the same task queue.
import type { MatchPersonWorkflow } from '@cip/shared';

const {
  validateExtractionActivity,
  matchCertDefinition,
  // 58D-B: the legacy match-employee.activity.ts is now a thin shim that
  // starts MatchPersonWorkflow. Some callers (existing pre-Route-A tests)
  // still reach for it; new code uses startChild directly as below.
  notifyHitlActivity,
  persistCertActivity,
  publishCertProcessedActivity,
  signalDocumentServiceCallback,  // NEW — calls back to doc-service workflow with moduleRecordId
} = proxyActivities<typeof activities>({ startToCloseTimeout: '30s', retry: { maximumAttempts: 3 } });

export const hitlDecisionSignal = defineSignal<[HITLDecisionSignal]>('hitlDecision');

export async function CertificationProcessingWorkflow(input: ProcessDocumentInput): Promise<void> {
  // Workflow ID pattern: {workflowType}-{tenantId}-{entityId}
  // workflowId: `CertProcess-${input.tenantId}-${certSubmissionId}`
  const { tenantId, documentId, extractedFeatures, uploaderEmployeeId, uploaderHintText, conversationId } = input;
  const certSubmissionId = await createCertSubmissionRow({ tenantId, documentId });

  let hitlDecision: HITLDecisionSignal | undefined;
  setHandler(hitlDecisionSignal, (decision) => { hitlDecision = decision; });

  // No fetch/preClassify/vision — features come from doc-service.
  await validateExtractionActivity({ tenantId, certSubmissionId, extractedFeatures });

  // Subject resolution + cert-definition match run in parallel. The matcher
  // is a child workflow (58D-A); cert-def match is a synchronous activity.
  const matchPersonHandle = await startChild<typeof MatchPersonWorkflow>('MatchPersonWorkflow', {
    args: [{
      tenantId,
      candidateText: extractedFeatures.holderName ?? uploaderHintText ?? '',
      structuredHints: extractedFeatures.holderName
        ? { fullName: extractedFeatures.holderName }
        : undefined,
      context: {
        source:               'cert_holder',
        callerSubmissionId:   certSubmissionId,
        ...(conversationId       !== undefined && { conversationId }),
        ...(uploaderEmployeeId   !== undefined && { uploaderEmployeeId }),
      },
      policy: {
        onNoMatch:    'fail',
        onAmbiguous:  'uploader_pickcard',
        // autoThreshold + includeInactive default from per-tenant tunables
      },
    } satisfies MatchPersonInput],
    workflowId: `MatchPerson-${tenantId}-${certSubmissionId}`,
    taskQueue:  'cip-hr-tasks',
  });

  const [personResult, certMatch] = await Promise.all([
    matchPersonHandle.result() as Promise<MatchPersonOutput>,
    matchCertDefinition({ tenantId, certSubmissionId, extractedFeatures }),
  ]);

  if (personResult.outcome === 'no_resolution') {
    // Matcher couldn't resolve and cert policy was 'fail'. Surface as a
    // structured failure so doc-service routes the doc to its own admin
    // queue (no_resolution is not a transient retry case).
    await signalDocumentServiceCallback({
      tenantId, documentId,
      moduleRecordId: certSubmissionId,
      status: 'rejected',
      reason: 'subject_unresolved',
    });
    throw ApplicationFailure.create({ type: 'SubjectUnresolved', nonRetryable: true });
  }
  const subjectEmployeeId = personResult.employeeId!;

  // Cert-DATA HITL (low-confidence extraction or low-confidence cert-def
  // match). Subject ambiguity HITL is owned by MatchPersonWorkflow and
  // never reaches this branch.
  const needsHitl =
    extractedFeatures.overallConfidence < 0.85 ||
    certMatch.confidence < 0.7;

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
    status:         'accepted',
  });
}
```

The cert workflow shrinks substantially — three OCR/extract steps
fewer. Subject resolution lives in `MatchPersonWorkflow` (58D-A
infra; 58D-B integration). Cert-DATA HITL stays for low-confidence
extraction or cert-definition matches.

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
8. **Alias-resolver consolidation: zero behavior change.** Cert
   workflow + bot LangGraph nodes resolve the same aliases as
   pre-58E for the same `(tenantId, service, purpose)` triples
   (verified against the existing alias-resolver test set, now
   moved to `@cip/shared`). The two old files are gone; no service
   imports them anymore. `pnpm -r run typecheck` passes. The 5-min
   cache hit rate is observable as before (hr-service activities
   now hitting hr-service's own `/admin/routing-rules` ~once per
   5 min per pod per tenant-service pair is acceptable).

---

## Forward refs

- 58F adds the reclassify path: uses `revokeFor` activity (stub
  added in 58E's cert module, throws 'not implemented' until 58F).
- 58G adds the soft/hard-purge cron.
- 58H replaces the LLM classifier (58C) with a per-tenant sklearn
  classifier as training data accumulates.
- 58I adds cert template-and-compare.
