# Slice 58G — soft-delete, configurable hard-purge, audit retention

> **Why this exists:** Locked decisions: soft-delete is the default
> destructive action; hard-purge is a separate manual or
> time-triggered step; per-tenant max-age controls auto-hard-purge;
> 7-year audit retention is the ceiling. 58G implements the cron,
> the tools, the partition rotation, and the GDPR Article 17 strict
> erasure mode for tenants that need it.
>
> Cross-cuts with 58F: hard-purge of `routed`/`archived` docs may
> optionally cascade-revoke via the module's `revokeFor` (off by
> default — purge of source bytes is independent of compliance
> records).

---

## Files in scope

```
packages/document-service/src/modules/retention/                         NEW directory
├── workflows/
│   ├── soft-purge-cron.workflow.ts                                      NEW (Temporal Schedule; daily; auto hard-purge of expired soft-purged docs)
│   ├── audit-partition-rotation.workflow.ts                             NEW (Schedule; 1st of month; ensures next 3 months exist)
│   └── index.ts                                                         NEW
├── activities/
│   ├── walk-soft-purged.activity.ts                                     NEW (paginated cursor over expired soft-purged rows)
│   ├── hard-purge-document.activity.ts                                  NEW (S3 delete → DB transaction; idempotent)
│   ├── redact-pii-from-audit.activity.ts                                NEW (GDPR strict mode only)
│   ├── restore-document.activity.ts                                     NEW (transition pre_purge_state; restart workflow if needed)
│   ├── ensure-audit-partition.activity.ts                               NEW (CREATE TABLE ... PARTITION OF for next month)
│   └── index.ts                                                         NEW
└── mcp-tools/
    ├── document-soft-purge.tool.ts                                      NEW (admin: documents.admin.purge)
    ├── document-hard-purge.tool.ts                                      NEW (admin: documents.admin.purge; immediate; requires confirmationToken)
    ├── document-restore.tool.ts                                         NEW (admin: documents.admin.unpurge)
    ├── document-purge-list.tool.ts                                      NEW (admin: see soft-purged + days-until-hard-purge)
    └── index.ts                                                         NEW

packages/document-service/src/modules/ingest/workflows/
└── document-processing.workflow.ts                                      MOD (`scan_failed`, `failed`, `archived` add purge-can-trigger guards in phase loop)

packages/document-service/src/db/migrations/
├── 012_audit_partition_rotation_baseline.sql                            NEW (creates next 6 months of partitions to bootstrap)
└── 013_documents_purge_indices.sql                                      NEW (covering index for soft-purge walker)

packages/hr-service/src/db/migrations/
└── 044_documents_retention_tunables.sql                                 NEW

slices/SLICE_58_OPERATOR_RUNBOOK.md                                      MOD (add: drop ancient audit partitions; restore semantics; GDPR mode)
```

---

## Hard rules

1. **Hard-purge is irreversible.** Tool requires
   `confirmationToken=$documentId` echoed back to confirm intent;
   audit captures the actor and confirmation step.
2. **S3 delete first, DB update second.** Both idempotent; on
   retry, S3 returns 204 even for already-deleted objects, DB
   `WHERE lifecycle_state='soft_purged'` clauses skip already-purged
   docs.
3. **Audit rows are NEVER deleted by 58G.** 7-year retention is the
   ceiling; partition drop is a separate, manual operator action.
4. **Per-tenant `documents.hard_purge_after_days` defaults to NULL**
   = manual-only. Setting it to a number opts in to auto-hard-purge.
5. **GDPR strict erasure** is opt-in via tunable
   `documents.gdpr_strict_erasure=true`. Off by default — most
   compliance contexts prefer audit retention over erasure.
6. **Hard-purge does NOT cascade-revoke module records by default.**
   Source bytes are separate from compliance records. Tunable
   `documents.hard_purge_cascade_revoke=true` enables cascading via
   58F's `revokeFor` flow.
7. **Restore validates resumability.** If pre_purge_state is an
   active workflow state, restore restarts the workflow at that
   phase (depends on 58F's phase-loop shape). If terminal, just
   transitions the row.
8. **Soft-purge of `reclassification_requested` docs** transitions
   the approval workflow with a deny + reason='document_purged'
   before flipping the lock.
9. **Cron uses Temporal Schedules**, mirroring slice 57B/57C
   pattern. Not k8s CronJob.

---

## Tunables

```sql
INSERT INTO bot_tunables (key, value, description, scope) VALUES
  ('documents.audit_retention_years',         '7',     'Audit retention ceiling (HIPAA-safe)',                'global'),
  ('documents.hard_purge_after_days',         'NULL',  'Auto hard-purge soft-purged docs after N days; NULL = manual-only', 'tenant'),
  ('documents.hard_purge_cron_hour',          '4',     'UTC hour daily soft-purge walker runs',               'global'),
  ('documents.partition_lookahead_months',    '3',     'How many monthly audit partitions to maintain ahead', 'global'),
  ('documents.gdpr_strict_erasure',           'false', 'On hard-purge, also redact PII from audit + null FKs','tenant'),
  ('documents.hard_purge_cascade_revoke',     'false', 'On hard-purge of routed/archived, also call revokeFor','tenant'),
  ('documents.soft_purge_walker_batch_size',  '100',   'Documents per walker iteration',                      'global'),
  ('documents.s3_delete_max_attempts',        '5',     'Retry attempts for S3 delete inside hard-purge',      'global')
ON CONFLICT DO NOTHING;
```

---

## `hardPurgeDocumentActivity` — atomicity pattern

```typescript
export async function hardPurgeDocumentActivity(input: {
  tenantId: string; documentId: string;
  actorEmployeeId?: string;     // null for cron-driven
  reason: 'manual' | 'auto_expired' | 'cascade_from_module_purge';
  cascadeRevoke?: boolean;
  gdprStrictErasure?: boolean;
}): Promise<{ purged: boolean; bytesDeleted: number; auditRedacted: boolean }> {

  // 1. Idempotency check — already hard-purged?
  const [doc] = await withActorContext(db, systemActorContext(input.tenantId), (tx) =>
    tx.select().from(documents).where(eq(documents.id, input.documentId)),
  );
  if (!doc) throw new Error(`document not found: ${input.documentId}`);
  if (doc.lifecycleState === 'hard_purged') {
    return { purged: false, bytesDeleted: 0, auditRedacted: false };
  }

  // 2. Optional cascade-revoke BEFORE byte delete
  //    (so we don't delete bytes the module workflow may need to read for revoke evidence)
  if (input.cascadeRevoke && doc.downstreamModuleRecordId && doc.module) {
    await invokeRevokeForActivity({
      tenantId: input.tenantId, documentId: input.documentId,
      moduleRecordId: doc.downstreamModuleRecordId,
      module: doc.module,
      reason: 'hard_purge', requestedByEmployeeId: input.actorEmployeeId ?? '00000000-0000-0000-0000-000000000000',
    });
  }

  // 3. S3 delete (idempotent — HTTP 204 even if already gone)
  await s3DeleteObject({ bucket: doc.s3Bucket, key: doc.s3Key });

  // 4. DB transaction: zero PII fields, transition state, write audit
  let auditRedacted = false;
  await withActorContext(db, systemActorContext(input.tenantId), async (tx) => {
    await tx.update(documents).set({
      lifecycleState: 'hard_purged',
      hardPurgedAt: new Date(),
      // Zero potentially-PII content fields
      ocrText: null,
      extractedFeatures: null,
      generic_features: null,
      sensitivityEvidence: null,
      classificationEvidence: null,
      uploaderHintText: null,
      stateReason: null,
      // GDPR strict mode: also null the actor FKs
      ...(input.gdprStrictErasure
        ? { uploaderEmployeeId: null, subjectEmployeeId: null }
        : {}),
    }).where(eq(documents.id, input.documentId));

    await tx.insert(auditEvents).values({
      tenantId: input.tenantId,
      documentId: input.documentId,
      actorEmployeeId: input.actorEmployeeId,
      actorRole: input.actorEmployeeId ? 'admin' : 'system',
      eventType: 'hard_purged',
      payload: {
        reason: input.reason,
        bytesDeleted: doc.sizeBytes,
        cascadeRevoked: !!input.cascadeRevoke,
        gdprStrictErasure: !!input.gdprStrictErasure,
        priorState: doc.lifecycleState,
      },
    });

    // 5. Embeddings cascade-deletes via FK ON DELETE CASCADE on document_embeddings.document_id.
    //    Nothing else to do here.

    if (input.gdprStrictErasure) {
      await redactPiiFromAuditActivityInline(tx, input.tenantId, input.documentId);
      auditRedacted = true;
    }
  });

  return { purged: true, bytesDeleted: doc.sizeBytes, auditRedacted };
}
```

The S3 delete + DB update are NOT in a single distributed transaction
(impossible across systems). Atomicity is achieved by:
- S3 first (idempotent retries)
- DB update guarded by `WHERE lifecycle_state='soft_purged' OR lifecycle_state IN (...)` so re-runs are no-ops once state has flipped
- Audit row written in same DB tx as the state flip

---

## GDPR strict erasure

```typescript
async function redactPiiFromAuditActivityInline(
  tx: PgTransaction, tenantId: string, documentId: string,
): Promise<void> {
  // Update all audit_events for this document — null actor FKs, redact payload
  await tx.update(auditEvents).set({
    actorEmployeeId: null,
    payload: sql`jsonb_set(payload, '{redacted}', 'true'::jsonb)`,    // payload now {redacted: true} only
  }).where(and(eq(auditEvents.tenantId, tenantId), eq(auditEvents.documentId, documentId)));

  // Reclassification requests
  await tx.update(reclassificationRequests).set({
    requestedBy: null, reasonNotes: null, newDocTypeHint: null,
  }).where(and(eq(reclassificationRequests.tenantId, tenantId), eq(reclassificationRequests.documentId, documentId)));
}
```

The redaction is irreversible — once GDPR strict erasure runs, no
forensic recovery is possible. Document this prominently in the
admin tool's confirmation card.

---

## `restoreDocumentActivity`

```typescript
const ACTIVE_PHASES = new Set([
  'quarantined','scanning','classifying','awaiting_subject',
  'awaiting_routing','hitl_admin_queue','reclassification_requested',
  'routed',                                       // 'routed' = waiting on module callback; restart phase loop at 'awaiting_module_callback'
]);

export async function restoreDocumentActivity(input: {
  tenantId: string; documentId: string; actorEmployeeId: string;
}): Promise<{ restored: boolean; restartedWorkflow: boolean; restoredState: string }> {

  const [doc] = await withActorContext(db, adminActorContext(input.tenantId, input.actorEmployeeId), (tx) =>
    tx.select().from(documents).where(eq(documents.id, input.documentId)),
  );
  if (!doc) throw new Error('not found');
  if (doc.lifecycleState !== 'soft_purged') {
    throw new Error(`cannot restore from state ${doc.lifecycleState}`);
  }
  const target = doc.prePurgeState ?? 'failed';                 // safety: failed if state lost
  if (target === 'hard_purged') throw new Error('hard_purged is unrestorable');

  await withActorContext(db, adminActorContext(input.tenantId, input.actorEmployeeId), async (tx) => {
    await tx.update(documents).set({
      lifecycleState: target, prePurgeState: null, softPurgedAt: null,
    }).where(eq(documents.id, input.documentId));

    await tx.insert(auditEvents).values({
      tenantId: input.tenantId, documentId: input.documentId,
      actorEmployeeId: input.actorEmployeeId, actorRole: 'admin',
      eventType: 'restored',
      payload: { restoredToState: target },
    });
  });

  let restartedWorkflow = false;
  if (ACTIVE_PHASES.has(target)) {
    // Workflow was killed when doc went soft_purged — restart at the right phase
    const temporal = await createTemporalClient();
    // Workflow ID pattern: {workflowType}-{tenantId}-{entityId}
    const workflowId = `DocumentProcess-${input.tenantId}-${input.documentId}`;
    await temporal.workflow.start(DocumentProcessingWorkflow, {
      workflowId, taskQueue: process.env['TEMPORAL_TASK_QUEUE_DOCUMENTS'] ?? 'cip-documents-tasks',
      args: [{ /* original input snapshot reconstructed from documents row */
        tenantId: input.tenantId, documentId: input.documentId,
        uploaderEmployeeId: doc.uploaderEmployeeId,
        startingPhase: target,                                   // phase loop reads this on first iteration
      }],
    });
    restartedWorkflow = true;
  }

  return { restored: true, restartedWorkflow, restoredState: target };
}
```

`DocumentProcessingWorkflow`'s phase-loop accepts an optional
`startingPhase` input (added in 58F when the loop is introduced).
On first iteration: `phase = input.startingPhase ?? 'scan'`.

---

## Soft-purge cron workflow

```typescript
export async function SoftPurgeCronWorkflow(): Promise<void> {
  // Iterate tenants with hard_purge_after_days set
  const tenants = await listTenantsWithAutoPurgeActivity();

  for (const tenant of tenants) {
    let cursor: string | null = null;
    do {
      const batch = await walkSoftPurgedActivity({
        tenantId: tenant.id,
        olderThanDays: tenant.hardPurgeAfterDays,
        cursor,
        limit: tunables.soft_purge_walker_batch_size,
      });

      for (const docId of batch.documentIds) {
        try {
          await hardPurgeDocumentActivity({
            tenantId: tenant.id,
            documentId: docId,
            reason: 'auto_expired',
            cascadeRevoke: tenant.cascadeRevoke,
            gdprStrictErasure: tenant.gdprStrictErasure,
          });
        } catch (err) {
          // Audit failure but continue — don't let one bad doc block the batch
          await auditPurgeFailureActivity({ tenantId: tenant.id, documentId: docId, error: String(err) });
        }
      }
      cursor = batch.nextCursor;
    } while (cursor !== null);
  }
}
```

Schedule: daily at 04:00 UTC (configurable via tunable).

---

## Audit partition rotation workflow

```typescript
export async function AuditPartitionRotationWorkflow(): Promise<void> {
  const lookahead = tunables.partition_lookahead_months;       // default 3
  const today = new Date();

  for (let i = 1; i <= lookahead; i++) {
    const target = new Date(today.getFullYear(), today.getMonth() + i, 1);
    await ensureAuditPartitionActivity({ year: target.getFullYear(), month: target.getMonth() + 1 });
  }
}
```

`ensureAuditPartitionActivity`:

```sql
CREATE TABLE IF NOT EXISTS cip_documents.audit_events_${YYYY}_${MM}
  PARTITION OF cip_documents.audit_events
  FOR VALUES FROM ('${YYYY}-${MM}-01') TO ('${YYYY}-${MM_NEXT}-01');
```

Schedule: 1st of each month @ 02:00 UTC.

---

## MCP tools

### `document_soft_purge`

```
Permission: documents.admin.purge
Args:       { documentId, reason }
Behavior:
  Read documents row.
  IF state in ('hard_purged','soft_purged'): error.
  IF state in ('reclassification_requested'): also send 'reclassificationDecision' { action: 'deny', note: 'document_purged' } first.
  IF state in ('routed','classifying','awaiting_subject','awaiting_routing','hitl_admin_queue'):
    cancel the current DocumentProcessingWorkflow run (Temporal cancel).
  In one tx:
    UPDATE documents SET lifecycle_state='soft_purged', pre_purge_state=current_state, soft_purged_at=NOW()
    INSERT audit_events ('soft_purged', ...)
```

### `document_hard_purge`

```
Permission: documents.admin.purge
Args:       { documentId, confirmationToken }                  // confirmationToken MUST equal documentId
Behavior:
  IF token != documentId: error 'confirmation mismatch'
  Read tunables for tenant: cascade_revoke, gdpr_strict_erasure
  Call hardPurgeDocumentActivity directly (synchronous)
  Return summary
```

### `document_restore`

```
Permission: documents.admin.unpurge
Args:       { documentId }
Behavior:
  Call restoreDocumentActivity
  Return { restoredState, restartedWorkflow }
```

### `document_purge_list`

```
Permission: documents.admin.read
Args:       { state?: 'soft_purged'|'hard_purged'|'all', limit? }
Returns:    Array<{
    documentId, fileName, lifecycleState,
    softPurgedAt, hardPurgedAt,
    daysUntilAutoHardPurge: number | null,    // null if no auto config OR already hard
    prePurgeState, sizeBytes
  }>
```

---

## Acceptance criteria

1. **Manual soft-purge → restore**: soft-purge a doc in `archived`.
   Verify state, pre_purge_state, audit row. Restore. Verify state
   returned to `archived`, no workflow restart needed.
2. **Manual soft-purge mid-flight → restore restarts workflow**:
   soft-purge a doc in `awaiting_subject` (mid-HITL). Verify the
   running workflow was cancelled. Restore. Verify a new
   DocumentProcessingWorkflow run was started with `phase='subject'`.
3. **Manual hard-purge**: hard-purge an archived doc. S3 object 404
   on a subsequent GET. ocr_text/extracted_features/generic_features
   are null. Audit row exists.
4. **Auto-hard-purge cron**: set tenant's `hard_purge_after_days=30`.
   Insert a doc with `soft_purged_at` 31 days ago. Trigger
   `SoftPurgeCronWorkflow`. Verify doc transitioned to hard_purged.
5. **GDPR strict mode**: enable for tenant. Hard-purge a doc.
   Audit rows for that doc have `payload={redacted: true}` and
   `actor_employee_id=null`. Documents row has uploader/subject
   IDs nulled.
6. **Cascade revoke**: enable for tenant. Hard-purge an archived
   doc whose downstream is a cert. Verify cert + cert_submission
   both transition to `revoked`.
7. **Idempotent retries**: kill the DB connection mid-purge.
   On retry, no double-S3-delete and no doubled audit row.
8. **Partition rotation**: trigger
   `AuditPartitionRotationWorkflow`. Verify 3 new monthly
   partitions exist (or no-op if already there).
9. **Hard-purge of `reclassification_requested` doc**: verify the
   pending approval workflow received a deny signal first.

---

## Cross-references

- 58F: reclassification path also runs against doc state. Ensure
  soft-purge cleanly cancels approval workflows. Ensure hard-purge
  with `cascade_revoke=true` calls 58F's `invokeRevokeForActivity`.
- 58H/58I: training data and templates derived from purged docs
  are stale. Tunable in 58H to filter training data exports by
  `lifecycle_state NOT IN ('soft_purged','hard_purged')`.
