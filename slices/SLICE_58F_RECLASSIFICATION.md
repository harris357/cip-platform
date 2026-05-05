# Slice 58F — reclassification (uploader-initiated + admin-approved)

> **Why this exists:** Locked in 58 design: original uploader can
> reclassify. In-flight reclassify is self-service; reclassify after
> the doc has reached `routed` or `archived` requires admin approval
> AND a `revokeFor` callback to undo the prior module record.
>
> 58F implements the state-machine transitions, the uploader-initiated
> reclassify card, the admin approval workflow, the `revokeFor`
> activity in the cert module (stubbed in 58E), and the **phase-loop
> rewrite of `DocumentProcessingWorkflow`** that makes "rewind"
> semantically possible in Temporal.

---

## Architectural shift — `DocumentProcessingWorkflow` becomes phase-driven

**Why the rewrite is necessary**: Temporal workflows are deterministic
and event-sourced — they don't literally rewind. The 58B workflow
was a linear sequence (scan → features → … → route). To "rewind to
classify" we need either ContinueAsNew (heavy, needs caller support)
or a **phase loop** where the workflow re-evaluates its current phase
on each iteration. Phase loop is the cleaner fit.

```typescript
// document-processing.workflow.ts (replaces 58B's linear shape)

type Phase =
  | 'scan' | 'features' | 'sensitivity'
  | 'classify' | 'extract'
  | 'subject' | 'route'
  | 'awaiting_module_callback' | 'archived' | 'failed';

export async function DocumentProcessingWorkflow(input: DocumentProcessingInput): Promise<void> {
  // Workflow ID pattern: {workflowType}-{tenantId}-{entityId}
  // workflowId: `DocumentProcess-${input.tenantId}-${input.documentId}`
  let phase: Phase = 'scan';

  // Signals — declared once at the top of the workflow function
  const reclassifySignal = defineSignal<[ReclassifyResolutionPayload]>('reclassifyResolution');
  let reclassifyPayload: ReclassifyResolutionPayload | undefined;
  setHandler(reclassifySignal, (p) => { reclassifyPayload = p; });

  const subjectSignal = defineSignal<[SubjectResolutionPayload]>('subjectResolution');
  let subjectPayload: SubjectResolutionPayload | undefined;
  setHandler(subjectSignal, (p) => { subjectPayload = p; });

  const moduleCallbackSignal = defineSignal<[ModuleCallbackPayload]>('moduleCallback');
  let moduleCallback: ModuleCallbackPayload | undefined;
  setHandler(moduleCallbackSignal, (p) => { moduleCallback = p; });

  // Phase query — admin tools use it to peek without waiting
  setHandler(defineQuery<Phase>('phase'), () => phase);

  while (phase !== 'archived' && phase !== 'failed') {
    // The reclassify signal is checked at every safe point. When fired,
    // it overrides the natural next-phase transition.
    if (reclassifyPayload) {
      phase = 'classify';
      reclassifyPayload = undefined;
      // clearForReclassificationActivity already ran inside the approval workflow
      // OR (for self-serve in-flight reclassify) ran via the MCP tool
      continue;
    }

    switch (phase) {
      case 'scan':       /* run scanForVirusesActivity; on success → 'features', on threat → 'failed' */ break;
      case 'features':   /* generic + embedding + fingerprint → 'sensitivity' */ break;
      case 'sensitivity':/* L1+L2+L3 → 'classify' */ break;
      case 'classify':   /* LLM classify; below threshold → HITL → on resolve → 'extract' */ break;
      case 'extract':    /* runExtractionStrategyActivity → 'subject' */ break;
      case 'subject':    /* resolveSubjectActivity + HITL → 'route' */ break;
      case 'route':      /* routeDocumentActivity + start downstream → 'awaiting_module_callback' */ break;
      case 'awaiting_module_callback':
        await condition(() => moduleCallback !== undefined || reclassifyPayload !== undefined);
        if (reclassifyPayload) continue;          // top-of-loop will handle
        phase = 'archived';
        break;
    }
  }
}
```

The 58B implementation must adopt this shape from the start.
Updating 58B's workflow file in 58F is OK but the cleaner path is
to write it phase-loop-shaped in 58B (this slice doc retroactively
documents that constraint — see "58B addendum" at the end).

---

## Files in scope

```
packages/document-service/src/modules/reclassification/                NEW directory
├── workflows/
│   ├── reclassification-approval.workflow.ts                          NEW (admin approval flow for routed/archived)
│   └── index.ts                                                       NEW
├── activities/
│   ├── clear-for-reclassification.activity.ts                         NEW (surgical state clear; preserves embedding/fingerprint/subject)
│   ├── cancel-downstream-workflow.activity.ts                         NEW (sends Temporal cancellation to running module workflow)
│   ├── invoke-revoke-for.activity.ts                                  NEW (calls module's revokeFor by name on its task queue)
│   ├── notify-uploader-reclassify-decision.activity.ts                NEW (proactive Teams message via bot-progress channel)
│   └── index.ts                                                       NEW
└── mcp-tools/
    ├── document-reclassify-request.tool.ts                            NEW (uploader-facing self-serve OR request-approval)
    ├── document-reclassify-approve.tool.ts                            NEW (admin)
    ├── document-reclassify-deny.tool.ts                               NEW (admin)
    ├── document-reclassify-list.tool.ts                               NEW (admin queue: pending requests)
    └── index.ts                                                       NEW

packages/document-service/src/modules/ingest/workflows/
└── document-processing.workflow.ts                                    MOD (handle reclassifySignal at top of phase loop; called out in shape above)

packages/document-service/src/db/migrations/
├── 010_documents_reclassification_columns.sql                         NEW (add reclassification_in_flight + reclassification_request_id)
└── 011_document_reclassification_requests_table.sql                   NEW (cip_documents.reclassification_requests)

packages/teams-bot/src/intent/
└── document-reclassify-card.ts                                        NEW (offered on /turn footer + via documents_status response)

packages/hr-service/src/modules/certifications/activities/
└── revoke-for.activity.ts                                             MOD (REPLACE 58E's stub with real impl + idempotency)

packages/hr-service/src/db/migrations/
├── 042_documents_reclassification_tunables.sql                        NEW
└── 043_certifications_revoke_columns.sql                              NEW (revoked_at, revoked_reason, revoked_by_request_id)
```

---

## Hard rules

1. **State-aware self-serve gate**: `document_reclassify_request`
   tool checks `lifecycle_state` before allowing self-serve.
   Self-serve OK for: `quarantined`, `scanning`, `scan_failed`,
   `classifying`, `awaiting_subject`, `awaiting_routing`,
   `hitl_admin_queue`, `failed`. Approval-required for:
   `routed`, `archived`. (`awaiting_module_callback` is a phase-loop *concept* but not a DB state — the doc sits in `routed` while the module workflow runs.)
2. **`revokeFor` is mandatory** for any state past `routed`. If a
   module hasn't implemented it (throws `'not implemented'`), the
   approval workflow fails (state → `failed`) and admin must
   manually deal with it. **58F implements `revokeFor` for cert
   only**; future module owners implement their own.
3. **Concurrency lock**: documents row carries
   `reclassification_in_flight BOOLEAN NOT NULL DEFAULT false`.
   The MCP tool transactionally reads-and-flips it; if already
   true, returns "another reclassification in progress."
4. **Reclassify pause is observable**: doc transitions to a new
   state `reclassification_requested` (added to 58A's CHECK list).
   Visible to admins via `document_reclassify_list`.
5. **Audit every transition**: `reclassification_requested`,
   `reclassification_approved` / `_denied` / `_timed_out`,
   `module_workflow_cancelled`, `revoked`,
   `reclassified_in_flight`, `reclassified_post_completion`. Each
   payload includes from-module/doc_type and to-module/doc_type.
6. **Self-serve reclassify on `awaiting_subject` does NOT clear
   subject_employee_id**. Subject is preserved unless the user
   explicitly says "wrong subject" (separate `reason='wrong_subject'`
   path that DOES clear).
7. **Approval TTL: 7 days.** After 7 days with no admin decision,
   workflow auto-denies, audits, notifies uploader.
8. **Idempotency in `revokeFor`**: if called twice with the same
   `(documentId, moduleRecordId)`, the second call is a no-op that
   returns the original `revokedAt`. Crucial for activity retries.
9. **Workflow ID for approval**:
   `Reclassify-${tenantId}-${documentId}-${requestId}` where
   requestId is a UUID per request. Multiple historical requests
   per doc → distinct workflow IDs.

---

## State clearing rules (`clearForReclassificationActivity`)

```typescript
type ReclassifyReason = 'wrong_doc_type' | 'wrong_module' | 'wrong_subject' | 'admin_correction' | 'other';

export async function clearForReclassificationActivity(input: {
  tenantId: string;
  documentId: string;
  reason: ReclassifyReason;
  newDocTypeHint?: string;        // uploader's stated correction (drives next classify pass)
  forceResensitize?: boolean;     // tunable + admin override (rare)
}): Promise<{ clearedFields: string[] }> {
  const cleared: string[] = [];

  await withActorContext(db, systemActorContext(input.tenantId), async (tx) => {
    // Fetch current state for forensic copy
    const [current] = await tx.select().from(documents).where(eq(documents.id, input.documentId));

    const update: Partial<typeof documents.$inferInsert> = {
      // Always clear classification + extraction on reclassify
      module: null,
      docType: null,
      classificationConfidence: null,
      classificationEvidence: null,
      extractedFeatures: null,
      extractionConfidence: null,
      // Always set forensic trail
      priorModule: current.module,
      priorDocType: current.docType,
      // Clear downstream pointers (revoke ran before this; record IDs are invalid now)
      downstreamWorkflowId: null,
      downstreamModuleRecordId: null,
      // Clear HITL/purge backrefs
      preHitlState: null,
      // Always clear in-flight lock
      reclassificationInFlight: false,
      reclassificationRequestId: null,
    };

    // Subject is preserved by default; only cleared on wrong_subject
    if (input.reason === 'wrong_subject') {
      update.subjectEmployeeId = null;
      update.subjectResolutionConfidence = null;
      update.subjectResolutionEvidence = null;
      cleared.push('subject_employee_id');
    }

    // Sensitivity preserved by default; only re-evaluated on explicit force
    if (input.forceResensitize) {
      update.sensitivityTier = null;
      update.sensitivityEvidence = null;
      cleared.push('sensitivity_tier');
    }

    await tx.update(documents).set(update).where(eq(documents.id, input.documentId));
    cleared.push('module','doc_type','classification_*','extracted_features','downstream_*');

    await tx.insert(auditEvents).values({
      tenantId: input.tenantId, documentId: input.documentId,
      actorRole: 'system',
      eventType: 'reclassified_in_flight',
      payload: { reason: input.reason, fromModule: current.module, fromDocType: current.docType, newDocTypeHint: input.newDocTypeHint, clearedFields: cleared },
    });
  });

  return { clearedFields: cleared };
}
```

**Preserved across reclassify**: `embedding`, `layout_fingerprint`,
`generic_features`, `subject_employee_id` (default), `sensitivity_*`
(default), `s3_key`, `sha256`. Bytes haven't changed; expensive-to-recompute
state stays.

---

## `ReclassificationApprovalWorkflow`

```typescript
export interface ReclassificationApprovalInput {
  tenantId: string;
  documentId: string;
  requestId: string;            // UUID — workflow ID component
  requestedBy: string;          // employee_id
  reason: ReclassifyReason;
  newDocTypeHint?: string;
  conversationId?: string;      // for proactive uploader notification
}

const APPROVAL_TTL = '7 days';

export async function ReclassificationApprovalWorkflow(input: ReclassificationApprovalInput): Promise<void> {
  // Workflow ID pattern: {workflowType}-{tenantId}-{entityId}
  // workflowId: `Reclassify-${input.tenantId}-${input.documentId}-${input.requestId}`

  const decisionSignal = defineSignal<[{ action: 'approve'|'deny'; adminEmployeeId: string; note?: string }]>('reclassificationDecision');
  let decision: { action: 'approve'|'deny'; adminEmployeeId: string; note?: string } | undefined;
  setHandler(decisionSignal, (d) => { decision = d; });

  // Notify admin queue (the request row was inserted by the MCP tool;
  // this just makes sure it's surfaced)
  await notifyAdminQueueActivity({ tenantId: input.tenantId, documentId: input.documentId, requestId: input.requestId });

  const decided = await condition(() => decision !== undefined, APPROVAL_TTL);

  if (!decided) {
    // TTL → auto-deny
    await recordDecisionActivity({ ...input, action: 'timed_out' });
    await notifyUploaderReclassifyDecisionActivity({ ...input, action: 'timed_out' });
    await releaseReclassificationLockActivity({ tenantId: input.tenantId, documentId: input.documentId });
    return;
  }

  if (decision!.action === 'deny') {
    await recordDecisionActivity({ ...input, action: 'denied', adminEmployeeId: decision!.adminEmployeeId, note: decision!.note });
    await notifyUploaderReclassifyDecisionActivity({ ...input, action: 'denied', note: decision!.note });
    await releaseReclassificationLockActivity({ tenantId: input.tenantId, documentId: input.documentId });
    return;
  }

  // Approved — orchestrate the rewind
  // 1. Cancel running downstream workflow if still active
  await cancelDownstreamWorkflowActivity({ tenantId: input.tenantId, documentId: input.documentId });

  // 2. Read documents row to get downstream_module_record_id (set if module callback already arrived)
  const doc = await readDocumentActivity({ tenantId: input.tenantId, documentId: input.documentId });

  // 3. If a module record was created, revoke it
  if (doc.downstreamModuleRecordId && doc.module) {
    await invokeRevokeForActivity({
      tenantId: input.tenantId,
      documentId: input.documentId,
      moduleRecordId: doc.downstreamModuleRecordId,
      module: doc.module,                                // routes to that module's task queue
      reason: 'reclassification',
      requestedByEmployeeId: input.requestedBy,
    });
  }

  // 4. Clear doc state for the rewind
  await clearForReclassificationActivity({
    tenantId: input.tenantId,
    documentId: input.documentId,
    reason: input.reason,
    newDocTypeHint: input.newDocTypeHint,
  });

  // 5. Signal the original DocumentProcessingWorkflow — top of phase loop will pick it up
  await signalDocumentProcessingWorkflowActivity({
    tenantId: input.tenantId,
    documentId: input.documentId,
    signalName: 'reclassifyResolution',
    payload: { newDocTypeHint: input.newDocTypeHint },
  });

  // 6. Audit + notify
  await recordDecisionActivity({ ...input, action: 'approved', adminEmployeeId: decision!.adminEmployeeId, note: decision!.note });
  await notifyUploaderReclassifyDecisionActivity({ ...input, action: 'approved', note: decision!.note });
}
```

`releaseReclassificationLockActivity` only flips
`reclassification_in_flight=false` for the deny / timeout paths.
On approve, the lock is released by `clearForReclassificationActivity`
(which also clears it).

---

## `cancelDownstreamWorkflowActivity` semantics

Temporal workflows can be cancelled via the client API. The activity:

1. Reads `documents.downstream_workflow_id`. If null, returns
   `{ cancelled: false, reason: 'no_downstream' }`.
2. Calls `temporal.workflow.getHandle(workflowId).cancel()`.
3. Polls workflow state: waits up to 30s for the workflow to enter
   one of: `Cancelled`, `Completed`, `Failed`, `Terminated`.
4. Returns the terminal state.

A subtle case: the module workflow may have *just* completed and
sent `moduleCallback` to the parent before our cancel arrived. In
that case `documents.downstreamModuleRecordId` is non-null and the
approval workflow proceeds to `revokeFor` (correct).

---

## `invokeRevokeForActivity` — module dispatch

```typescript
export async function invokeRevokeForActivity(input: {
  tenantId: string; documentId: string; moduleRecordId: string;
  module: string; reason: ReclassifyReason; requestedByEmployeeId: string;
}): Promise<{ success: boolean; compensatingActions: string[] }> {

  // Resolve task queue + activity name from the routing map (same table queried by 58E's routing)
  const route = await resolveModuleRouteActivity({ tenantId: input.tenantId, module: input.module, docType: '*' });
  const activityName = `revoke_${input.module}`;             // convention: 'revoke_certificate' for cert module

  // Start a child activity on the module's task queue.  Temporal's executeChildWorkflow
  // is the cleanest pattern; alternatively send a one-shot child-workflow that wraps the activity.
  const result = await executeChildWorkflow('ModuleRevokeChildWorkflow', {
    workflowId: `Revoke-${input.tenantId}-${input.documentId}-${randomUUID()}`,
    taskQueue: route.taskQueue,
    args: [{ tenantId: input.tenantId, documentId: input.documentId, moduleRecordId: input.moduleRecordId,
             reason: input.reason, requestedByEmployeeId: input.requestedByEmployeeId }],
  });

  return result as { success: boolean; compensatingActions: string[] };
}
```

`ModuleRevokeChildWorkflow` is a thin wrapper that calls the module's
`revokeFor` activity on the module's own task queue. Lives in the
module package (cert module ships its own).

---

## Cert `revokeFor` (replaces 58E's stub)

```typescript
// packages/hr-service/src/modules/certifications/activities/revoke-for.activity.ts
export async function revokeForActivity(input: RevokeForInput): Promise<RevokeForOutput> {
  const v = RevokeForInputSchema.parse(input);
  const compensating: string[] = [];

  // Idempotency: if cert_submission already revoked, return the original revokedAt
  const [existing] = await withTenantRLS(db, v.tenantId, (tx) =>
    tx.select({ status: certSubmissions.submissionStatus, revokedAt: certSubmissions.revokedAt })
      .from(certSubmissions).where(eq(certSubmissions.id, v.moduleRecordId)),
  );
  if (existing?.status === 'revoked' && existing.revokedAt) {
    return RevokeForOutputSchema.parse({
      success: true, revokedAt: existing.revokedAt.toISOString(),
      compensatingActions: ['noop_already_revoked'],
    });
  }

  await withTenantRLS(db, v.tenantId, async (tx) => {
    await tx.update(certSubmissions).set({
      submissionStatus: 'revoked',
      revokedAt: new Date(),
      revokedReason: v.reason,
      revokedByRequestId: v.requestedByEmployeeId,
    }).where(eq(certSubmissions.id, v.moduleRecordId));
    compensating.push('cert_submission.revoked');

    // Soft-revoke the certifications row (compliance record stays for audit)
    await tx.update(certifications).set({
      status: 'revoked', revokedAt: new Date(), revokedReason: v.reason,
    }).where(eq(certifications.submissionId, v.moduleRecordId));
    compensating.push('certification.revoked');
  });

  // Publish compliance event (downstream listeners react)
  await publishCertRevokedActivity({
    tenantId: v.tenantId, certSubmissionId: v.moduleRecordId, reason: v.reason,
  });
  compensating.push('compliance_event.cert_revoked.published');

  return RevokeForOutputSchema.parse({
    success: true,
    revokedAt: new Date().toISOString(),
    compensatingActions: compensating,
  });
}
```

DB additions in `043_certifications_revoke_columns.sql`:

```sql
ALTER TABLE cip_hr.cert_submissions
  ADD COLUMN revoked_at TIMESTAMPTZ,
  ADD COLUMN revoked_reason TEXT,
  ADD COLUMN revoked_by_request_id UUID;

ALTER TABLE cip_hr.certifications
  ADD COLUMN revoked_at TIMESTAMPTZ,
  ADD COLUMN revoked_reason TEXT;

-- The submissionStatus check constraint needs 'revoked' added if not present
```

---

## `reclassification_requests` table

```sql
CREATE TABLE cip_documents.reclassification_requests (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                   UUID NOT NULL,
  document_id                 UUID NOT NULL,
  requested_by                UUID NOT NULL,
  reason                      TEXT NOT NULL CHECK (reason IN ('wrong_doc_type','wrong_module','wrong_subject','admin_correction','other')),
  reason_notes                TEXT,
  new_doc_type_hint           TEXT,                  -- e.g. "this is first_aid not cpr"
  conversation_id             TEXT,
  status                      TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','denied','timed_out')),
  approver_employee_id        UUID,
  approver_note               TEXT,
  approval_workflow_id        TEXT NOT NULL,
  requested_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at                  TIMESTAMPTZ
);
CREATE INDEX reclass_requests_tenant_status_idx ON cip_documents.reclassification_requests(tenant_id, status);
CREATE INDEX reclass_requests_document_idx ON cip_documents.reclassification_requests(tenant_id, document_id, requested_at DESC);
```

---

## Documents-table additions (`010_*.sql`)

```sql
ALTER TABLE cip_documents.documents
  ADD COLUMN reclassification_in_flight BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN reclassification_request_id UUID,
  ADD COLUMN reclassification_count INT NOT NULL DEFAULT 0;

-- Add 'reclassification_requested' to lifecycle_state CHECK list:
ALTER TABLE cip_documents.documents DROP CONSTRAINT documents_lifecycle_state_check;
ALTER TABLE cip_documents.documents ADD CONSTRAINT documents_lifecycle_state_check
  CHECK (lifecycle_state IN (
    'quarantined','scanning','scan_failed',
    'classifying','awaiting_subject','awaiting_routing',
    'hitl_admin_queue','reclassification_requested',
    'routed','archived',
    'soft_purged','hard_purged','failed'
  ));

-- RLS: reclassification_requested is visible to uploader + admin (same as hitl_admin_queue)
-- Policy update extends 58A's policy to include reclassification_requested in the admin clause.
```

---

## Tunables

```sql
INSERT INTO bot_tunables (key, value, description, scope) VALUES
  ('documents.reclassify_self_serve_states', '["quarantined","scanning","scan_failed","classifying","awaiting_subject","awaiting_routing","hitl_admin_queue","failed"]', 'States in which uploader can reclassify without admin', 'tenant'),
  ('documents.reclassify_approval_ttl_days', '7', 'Auto-deny after this many days without admin decision', 'tenant'),
  ('documents.reclassify_force_resensitize', 'false', 'Recompute sensitivity tier on every reclassify (expensive)', 'tenant'),
  ('documents.reclassify_max_per_doc', '5', 'Hard cap on reclassifications per single document (rate-limit abuse)', 'tenant')
ON CONFLICT DO NOTHING;
```

---

## MCP tools

### `document_reclassify_request` (uploader-facing)

```
Permission: documents.upload (uploader of this doc) OR documents.admin.route
Args:       { documentId, reason, newDocTypeHint?, reasonNotes? }
Behavior:
  Read documents row.  Verify caller is uploader OR has documents.admin.route.
  Verify reclassification_in_flight=false.  Verify reclassification_count < max.
  In a single tx:
    - Set reclassification_in_flight=true, reclassification_count++
    - Insert reclassification_requests row (status='pending')
    - Audit reclassification_requested

  IF lifecycle_state in self_serve_states:
    - Run clearForReclassificationActivity directly (no approval)
    - Signal DocumentProcessingWorkflow ('reclassifyResolution', { newDocTypeHint })
    - Set request status='approved' (self-approved), decided_at=NOW()
    - Notify uploader: "Reclassifying immediately"

  ELSE (routed | archived; the awaiting_module_callback workflow phase falls under DB state 'routed'):
    - Start ReclassificationApprovalWorkflow
      workflowId: `Reclassify-${tenantId}-${documentId}-${requestId}`
    - Set documents.reclassification_request_id = requestId
    - Transition documents.lifecycle_state to 'reclassification_requested'
       (preserve current state in pre_hitl_state for the audit trail)
    - Notify uploader: "Submitted for admin review"
```

### `document_reclassify_approve` / `_deny` / `_list` (admin)

Standard pattern. Approve/deny send the `reclassificationDecision`
signal to the running approval workflow, with admin's employeeId
and optional note. Both gated on `documents.admin.route` (already
seeded in 58A — covers both manual routing and reclassify approval).

`_list` returns the queue grouped by tenant with relevant fields:

```
Permission: documents.admin.route
Args:       { status?: 'pending'|'approved'|'denied'|'timed_out', limit? }
Returns:    Array<{ requestId, documentId, fileName, requestedBy, requestedAt, reason, currentLifecycleState, fromModule, fromDocType, newDocTypeHint }>
```

---

## Bot adaptive card UX

Two surfaces:

1. **`/turn ${turnId}` footer** — adds a "🔄 Reclassify" Action.Submit
   for the doc tied to that turn. On click → opens a card with:
   - Document filename + current classification
   - Reason dropdown (wrong_doc_type | wrong_module | wrong_subject | other)
   - "What should it be?" text input
   - "Notes" optional textarea
   - [Submit] [Cancel] buttons

2. **`documents_status documentId=...`** — card response includes a
   "🔄 Reclassify" button if caller is uploader.

Submit dispatches via the existing invoke-router (slice 53):
`verb='documents.reclassify.submit'`, body=`{documentId, reason, newDocTypeHint, reasonNotes}`.

Bot handler (`document-reclassify-card.ts`):

1. Calls `document_reclassify_request` MCP tool.
2. Tool either runs the immediate path or starts the approval workflow.
3. Returns to bot a status: `'reclassifying_immediately' | 'pending_admin_approval'`.
4. Bot replies in the conversation with the appropriate confirmation.

---

## Notify-uploader path

`notifyUploaderReclassifyDecisionActivity`:

1. Read `reclassification_requests.conversation_id`.
2. If null (request was made via API not Teams): skip; uploader must
   poll status.
3. If present: publish to bot-progress channel
   `cip.bot.progress.${tenantId}.${conversationId}` with a
   `reclassify_decision` event. Bot subscriber renders a fresh card:
   - approved: "✅ Reclassification approved by admin. Reprocessing now…"
   - denied: "❌ Reclassification denied. Reason: {note}"
   - timed_out: "⏱ Reclassification request expired without admin review. Resubmit if still needed."

---

## Acceptance criteria

1. **Self-serve in-flight reclassify**: Upload a doc, let it reach
   `awaiting_subject`. Click reclassify with `reason='wrong_doc_type'`,
   `newDocTypeHint='first_aid'`. Doc state clears classification +
   extraction; preserves subject + features. Workflow re-enters
   `classify` phase. New classification fires. Verify final state
   reflects new doc_type, `prior_doc_type` set to old value,
   `reclassification_count=1`.
2. **Admin-approved post-archive reclassify**: Cert reaches
   `archived`. Click reclassify. Doc transitions to
   `reclassification_requested`. Admin sees the request in
   `document_reclassify_list`. Approves with note. Cert workflow
   gets cancelled (was already complete in this case — cancel is a
   no-op). `revokeFor` runs on cert module; cert + cert_submission
   both transition to `revoked`. Doc state clears, workflow rewinds,
   re-classifies. Final: doc has new module/doc_type, old cert
   record is `revoked`, new cert record exists.
3. **Approval TTL**: Submit reclassify on archived doc. Don't
   approve. After 7d (or seed `decided_at < NOW() - 7d` to fast-forward),
   workflow auto-denies. `reclassification_in_flight=false` again.
   Uploader sees timed-out card.
4. **Concurrency lock**: While a reclassify is `pending`, attempt
   another `document_reclassify_request` on the same doc. Tool
   returns "another reclassification in progress."
5. **Rate limit**: Set `documents.reclassify_max_per_doc=2` and run
   3 reclassifies. Third is rejected with rate-limit error.
6. **Idempotent revoke**: Manually invoke `revokeForActivity` twice
   on a cert. Second call returns the original `revokedAt` and a
   single compensating action `'noop_already_revoked'`.
7. **Uploader notification**: Reclassify on an archived doc with a
   conversationId. Approve. Verify Teams shows "Reclassification
   approved" message.
8. **`prior_module` preserved across multiple reclassifies**: After
   3 reclassifies, `reclassification_count=3`. `prior_module` and
   `prior_doc_type` reflect the most recent prior. Audit trail
   shows all 3 transitions in order.

---

## Forward refs

- 58G adds purge — purge of `reclassification_requested` doc
  cancels the approval workflow and clears the lock.
- 58H's classifier learning loop benefits from reclassify events
  (each reclassify is a Tier-3 training-data label).
