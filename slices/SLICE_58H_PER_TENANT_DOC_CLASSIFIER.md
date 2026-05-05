# Slice 58H — per-tenant doc-type classifier (mirrors slice 56N)

> **Why this exists:** 58C's LLM classifier is the v1 — works on
> day one but plateaus around 80–90% accuracy and stays expensive
> ($0.003/doc forever). As tenants accumulate classification
> evidence (admin-verdicted, reclassification-corrected, or
> clean-classified docs), we can train a sklearn classifier on
> `(ocr_text, generic_features)` → `(module, doc_type)`,
> typically reaching 95–98% accuracy at <$0.0001/doc inference.
> Architecture intentionally mirrors slice 56N's
> `RetrainModelWorkflow` so operators have one mental model for
> both classifier lifecycles.

---

## Decision: extend the Python `intent-classifier` service

Two paths considered:

| | New `doc-classifier` service | Extend `intent-classifier` |
|---|---|---|
| Code reuse | Duplicate sklearn boilerplate | Share TfidfVectorizer + LogReg + S3-poll + Langfuse trace import |
| Operations | Another helm chart, another image | Same image; 2 endpoints |
| Boundary | Cleaner separation between bot intent and document type | Mixed concerns in one service |

**Decision: extend.** The intent-classifier service already has all
the infra; doc classification is structurally identical (different
inputs, different label set). Adding a `doc_classifier` namespace
inside it is ~200 lines vs ~2000 for a new service.

---

## Files in scope

```
packages/document-service/src/modules/classifier-lifecycle/             NEW directory
├── workflows/
│   ├── retrain-doc-classifier.workflow.ts                              NEW (mirrors slice 56N RetrainModelWorkflow shape)
│   └── index.ts                                                        NEW
├── activities/
│   ├── index.ts                                                        NEW
│   ├── import-doc-classification-traces.activity.ts                    NEW (Langfuse → doc_classifier_training_data, trust-tiered)
│   ├── count-unreviewed-rows.activity.ts                               NEW
│   ├── notify-admin-review.activity.ts                                 NEW
│   ├── export-doc-training-data.activity.ts                            NEW (DB → S3 .ndjson per tenant)
│   ├── run-doc-trainer.activity.ts                                     NEW (HTTP shim → /admin/run-doc-train)
│   ├── eval-doc-classifier.activity.ts                                 NEW (eval gate; baseline = active model OR LLM; criteria below)
│   ├── promote-doc-classifier.activity.ts                              NEW (atomic active flip + S3 alias update)
│   ├── record-doc-classifier-run.activity.ts                           NEW
│   └── verify-hot-reload.activity.ts                                   NEW (polls intent-classifier /healthz to confirm)
└── mcp-tools/
    ├── doc-classifier-retrain.tool.ts                                  NEW (manual trigger; gated `documents.admin.classifier.retrain`)
    ├── doc-classifier-approve.tool.ts                                  NEW (admin signal)
    ├── doc-classifier-rollback.tool.ts                                 NEW (manual: flip active=false on a promoted model)
    ├── doc-classifier-status.tool.ts                                   NEW (read: active model + recent runs + drift indicators)
    └── index.ts                                                        NEW

packages/document-service/src/db/migrations/                            NEW
├── 014_doc_classifier_training_data.sql                                NEW
├── 015_doc_classifier_runs.sql                                         NEW
└── 016_doc_classifier_run_membership.sql                               NEW (which training rows each run consumed; for rollback forensics)

packages/document-service/src/modules/ingest/activities/
└── classify-document.activity.ts                                       MOD (sklearn-first path; LLM fallback for OOD; emits prediction telemetry to Langfuse)

packages/intent-classifier/src/                                         MOD
├── doc_train.py                                                        NEW (TfidfVectorizer + DictVectorizer + LogReg pipeline; per-tenant)
├── doc_predict.py                                                      NEW (loaded into FastAPI; /predict/doc endpoint)
├── doc_eval.py                                                         NEW (per-class recall, F1, confidence calibration)
├── doc_admin_api.py                                                    NEW (FastAPI router: /admin/run-doc-train, /run-doc-eval, /run-doc-export, /run-doc-promote)
├── s3_model_poller.py                                                  MOD (extend existing intent-model poller to also poll doc-classifier active.joblib per tenant)
└── main.py                                                             MOD (mount doc_admin_api router)

packages/hr-service/src/db/migrations/
└── 045_doc_classifier_tunables.sql                                     NEW

packages/hr-service/src/services/permission-catalog-seed.ts             MOD (add documents.admin.classifier.retrain to the catalog)

packages/intent-classifier/helm/values.yaml                             MOD (env: DOC_CLASSIFIER_ENABLED)
```

---

## Hard rules

1. **Reuse slice 56N's pattern verbatim.** The retrain workflow
   shape (import traces → count unreviewed → notify admin → wait
   signal → export → train → eval → upload → record → promote →
   verify) is the proven path. Do not invent a new orchestration.
2. **Trust ladder reused from slice 56L** (same column types,
   same trust_tier integers, same `source` strings semantically).
   Tier 4 = admin verdict, Tier 3 = reclassification, Tier 2 =
   clean-classified-archived, Tier 1 = excluded.
3. **Per-tenant models** with **platform-default fallback**.
   New tenants and tenants with insufficient data use the
   platform-default model trained across all consenting tenants.
   Eligibility for own model: ≥ 200 trust-tier-2-or-better rows
   AND ≥ 5 distinct doc_types.
4. **OOD class is `unknown_doc_type`**. Mirrors slice 56K's
   `out_of_scope`. When sklearn predicts `unknown_doc_type` OR
   max-softmax-prob < threshold, fall back to LLM classifier
   (which may also park as HITL).
5. **Eval gate criteria are hard-coded** but each criterion is
   a tunable. Hardcoding the SET of criteria prevents accidental
   "skip the recall floor" via tunable abuse.
6. **Hot-reload via S3 poll**, NOT a push notification. 5-minute
   poll interval; mirrors existing intent-classifier behavior.
7. **One active row per tenant** in `doc_classifier_runs`.
   Enforced via partial unique index. Promotion is a transaction
   that flips the old active=false and the new active=true.
8. **Activity output Zod-parsed** before persistence. (Non-Negotiable #5.)
9. **Workflow ID convention**: `RetrainDocClassifier-${tenantId}-${runId}`
   with the canonical comment.

---

## Schemas

### `doc_classifier_training_data`

```sql
CREATE TABLE cip_documents.doc_classifier_training_data (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                UUID NOT NULL,
  document_id              UUID,                                       -- nullable for synthetic data
  ocr_text                 TEXT NOT NULL,
  generic_features         JSONB NOT NULL,
  filename                 TEXT NOT NULL,
  sensitivity_tier         TEXT,
  -- Labels
  module                   TEXT NOT NULL,
  doc_type                 TEXT NOT NULL,
  -- Provenance / trust
  trust_tier               INT NOT NULL CHECK (trust_tier BETWEEN 1 AND 4),
  source                   TEXT NOT NULL CHECK (source IN ('admin_verdict','reclassification','clean_classified','synthetic')),
  classified_at            TIMESTAMPTZ NOT NULL,
  reviewed                 BOOLEAN NOT NULL DEFAULT false,
  is_synthetic             BOOLEAN NOT NULL DEFAULT false,
  source_doc_id            UUID,                                       -- forensic reference for synthetic rows
  imported_from_run_id     UUID,                                       -- workflow run that imported this row
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX dctd_tenant_label_idx ON cip_documents.doc_classifier_training_data(tenant_id, module, doc_type, trust_tier);
CREATE INDEX dctd_unreviewed_idx ON cip_documents.doc_classifier_training_data(tenant_id, reviewed) WHERE reviewed = false;
```

### `doc_classifier_runs`

```sql
CREATE TABLE cip_documents.doc_classifier_runs (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                UUID NOT NULL,                              -- '00000000-...' = platform default model
  workflow_id              TEXT NOT NULL,
  status                   TEXT NOT NULL CHECK (status IN ('training','evaluating','awaiting_approval','promoted','rolled_back','failed')),
  trigger                  TEXT NOT NULL CHECK (trigger IN ('cron','manual','auto_drift')),
  training_data_count      INT,
  training_data_per_class  JSONB,
  model_uri                TEXT,                                       -- s3 path to .joblib
  baseline_accuracy        DOUBLE PRECISION,
  candidate_accuracy       DOUBLE PRECISION,
  candidate_macro_f1       DOUBLE PRECISION,
  per_class_recall         JSONB,
  per_class_precision      JSONB,
  per_class_f1             JSONB,
  inference_p99_ms         DOUBLE PRECISION,
  confidence_calibration   JSONB,                                      -- {bin: avg_confidence, accuracy_in_bin}
  eval_gate_passed         BOOLEAN,
  eval_gate_reasons        JSONB,                                      -- {accuracy_lift: pass, per_class_recall: fail (cert.cpr=0.62), ...}
  approver_employee_id     UUID,
  approver_note            TEXT,
  promoted_at              TIMESTAMPTZ,
  rolled_back_at           TIMESTAMPTZ,
  rolled_back_reason       TEXT,
  active                   BOOLEAN NOT NULL DEFAULT false,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_at              TIMESTAMPTZ
);

CREATE UNIQUE INDEX dcr_active_per_tenant_idx
  ON cip_documents.doc_classifier_runs(tenant_id) WHERE active = true;
```

### `doc_classifier_run_membership`

```sql
CREATE TABLE cip_documents.doc_classifier_run_membership (
  run_id                   UUID NOT NULL,
  training_row_id          UUID NOT NULL,
  partition                TEXT NOT NULL CHECK (partition IN ('train','eval','holdout')),
  PRIMARY KEY (run_id, training_row_id)
);
```

Forensic table — for any `promoted` model, we can answer "what
exact rows trained this model?" Useful for debugging regressions
and for compliance ("model X was trained on this row that's been
flagged as sensitive — retrain without it").

---

## Trust ladder mapping (input source → trust_tier)

| Source event | trust_tier | source string |
|---|---|---|
| Admin used `documents_hitl_resolve_subject` AND set module/doc_type | 4 | `admin_verdict` |
| Admin used `documents_hitl_route_to_module` (manually routed an unrouted doc) | 4 | `admin_verdict` |
| Reclassification approved with new module/doc_type | 3 | `reclassification` |
| Self-serve in-flight reclassification with new doc_type | 3 | `reclassification` |
| LLM-classified, doc reached `archived`, no reclassification, classification_confidence ≥ 0.85 | 2 | `clean_classified` |
| LLM-classified, doc reached `archived`, classification_confidence < 0.85 | 1 (excluded) | n/a |
| Doc still in flight (any non-terminal state) | n/a (excluded) | n/a |
| Manually inserted via admin tool (label augmentation) | 4 | `admin_verdict` (with `is_synthetic=false`) |
| Generated by an LLM-augment pipeline (future; mirrors slice 56M) | 2 | `synthetic` (with `is_synthetic=true`) |

`importDocClassificationTracesActivity` queries:

```sql
SELECT d.id, d.ocr_text, d.generic_features, d.file_name,
       d.sensitivity_tier, d.module, d.doc_type, d.classified_at,
       CASE
         WHEN EXISTS (SELECT 1 FROM audit_events ae
                      WHERE ae.document_id=d.id AND ae.event_type='reclassification_approved'
                            AND ae.occurred_at <= d.classified_at)
              OR EXISTS (SELECT 1 FROM audit_events ae
                         WHERE ae.document_id=d.id AND ae.event_type IN ('subject_resolved','classified')
                               AND ae.actor_role = 'admin')
         THEN 4
         WHEN EXISTS (SELECT 1 FROM audit_events ae
                      WHERE ae.document_id=d.id AND ae.event_type='reclassification_approved')
         THEN 3
         WHEN d.classification_confidence >= 0.85 AND d.lifecycle_state='archived'
              AND NOT EXISTS (SELECT 1 FROM audit_events ae
                              WHERE ae.document_id=d.id AND ae.event_type='reclassification_approved')
         THEN 2
         ELSE 1
       END AS trust_tier,
       'documents_table'::text AS source
FROM cip_documents.documents d
WHERE d.tenant_id = $1
  AND d.classified_at IS NOT NULL
  AND d.classified_at > $2          -- since last run
  AND d.lifecycle_state IN ('archived','routed','soft_purged')
  AND d.module IS NOT NULL
  AND d.doc_type IS NOT NULL;
```

Tier 1 rows are filtered out at training time, but inserted into
`doc_classifier_training_data` for visibility (admin can review
what was excluded).

---

## Feature pipeline (Python, `doc_train.py`)

```python
from sklearn.pipeline import Pipeline, FeatureUnion
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.feature_extraction import DictVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import FunctionTransformer

# OCR text branch — uses standard text tokenization
text_pipeline = Pipeline([
    ('select_ocr', FunctionTransformer(lambda rows: [r['ocr_text'][:30000] for r in rows], validate=False)),
    ('tfidf', TfidfVectorizer(max_features=5000, min_df=2, ngram_range=(1, 2))),
])

# Generic features branch — flatten nested JSON, treat layoutType as categorical
def flatten_generic(rows):
    flat = []
    for r in rows:
        gf = r.get('generic_features', {}) or {}
        flat.append({
            'pageCount':       gf.get('pageCount', 0),
            'hasTable':        int(bool(gf.get('hasTable'))),
            'hasSignature':    int(bool(gf.get('hasSignature'))),
            'hasHandwriting':  int(bool(gf.get('hasHandwriting'))),
            'layoutType':      gf.get('layoutType', 'unknown'),    # one-hot via DictVectorizer
            'ocrTextLength':   gf.get('ocrTextLength', 0),
            'languageHint':    gf.get('languageHint', 'unknown'),  # one-hot
            'sensitivityTier': r.get('sensitivity_tier') or 'unknown',
            'fileExtension':   (r.get('filename') or '').split('.')[-1].lower()[:8],
        })
    return flat

generic_pipeline = Pipeline([
    ('select_generic', FunctionTransformer(flatten_generic, validate=False)),
    ('dictvec', DictVectorizer(sparse=True)),
])

union = FeatureUnion([('text', text_pipeline), ('generic', generic_pipeline)])

clf = Pipeline([
    ('features', union),
    ('logreg', LogisticRegression(class_weight='balanced', max_iter=2000, multi_class='multinomial', solver='lbfgs')),
])
```

Output label is the concatenated `f"{module}|{doc_type}"` — split
back on inference.

---

## Eval gate criteria

ALL must pass for auto-promotion (cron-triggered) or default-suggest
(manual-triggered with admin):

| Criterion | Threshold | Tunable |
|---|---|---|
| candidate_accuracy ≥ baseline_accuracy − 1% | mandatory regression bound | `documents.classifier.eval.regression_bound = 0.01` |
| candidate_accuracy ≥ baseline_accuracy + 5% | preferred lift | `documents.classifier.eval.preferred_lift = 0.05` |
| Per-class recall ≥ 0.7 for every class with ≥ 10 train rows | quality floor | `documents.classifier.eval.recall_floor = 0.7` and `min_class_size = 10` |
| Vocabulary preservation: every doc_type in past-90-days docs is in candidate's labels | mandatory | non-tunable (hard rule) |
| Inference p99 ≤ 50ms | latency bound | `documents.classifier.eval.p99_ms = 50` |
| Confidence calibration: Brier score ≤ 0.20 | calibration | `documents.classifier.eval.brier_max = 0.20` |

**Auto-promote** if all mandatory pass AND preferred_lift met.
**Awaiting approval** if mandatory pass but preferred_lift not met,
OR if cron policy requires manual approval (tunable
`documents.classifier.cron.always_require_approval`).
**Failed** if any mandatory regresses.

---

## Workflow shape

Mirrors slice 56N exactly:

```typescript
export async function RetrainDocClassifierWorkflow(input: {
  tenantId: string;
  trigger: 'cron'|'manual'|'auto_drift';
  triggeredBy?: string;                                     // employee_id (manual)
  forceApprovalRequired?: boolean;                          // manual override
}): Promise<RetrainDocClassifierOutput> {

  // Workflow ID pattern: {workflowType}-{tenantId}-{entityId}
  // workflowId: `RetrainDocClassifier-${tenantId}-${runId}`

  const runId = randomUUID();

  const adminApprovalSignal = defineSignal<[{ action: 'approve'|'reject'; employeeId: string; note?: string }]>('adminApproval');
  let approval: { action: 'approve'|'reject'; employeeId: string; note?: string } | undefined;
  setHandler(adminApprovalSignal, (a) => { approval = a; });

  setHandler(defineQuery<string>('step'), () => currentStep);
  let currentStep = 'init';

  await recordRunActivity({ tenantId: input.tenantId, runId, status: 'training', trigger: input.trigger });

  // 1. Import new traces from Langfuse → training_data table
  currentStep = 'import_traces';
  const imp = await importDocClassificationTracesActivity({ tenantId: input.tenantId, runId });

  // 2. Count unreviewed (Tier 1) — used to inform admin
  currentStep = 'count_unreviewed';
  const unreviewed = await countUnreviewedRowsActivity({ tenantId: input.tenantId });

  // 3. If policy requires admin review BEFORE training (when there are many unreviewed rows), notify and wait
  const requireApproval = input.forceApprovalRequired || tunables.always_require_approval;
  if (requireApproval) {
    currentStep = 'awaiting_admin_approval';
    await notifyAdminReviewActivity({ tenantId: input.tenantId, runId, unreviewedCount: unreviewed.count });
    await condition(() => approval !== undefined, '7 days');
    if (!approval || approval.action === 'reject') {
      await recordRunActivity({ tenantId: input.tenantId, runId, status: 'failed', /* ... */ });
      return { runId, promoted: false, reason: 'rejected_or_timed_out' };
    }
  }

  // 4. Export training data to S3 .ndjson
  currentStep = 'export';
  const exp = await exportDocTrainingDataActivity({ tenantId: input.tenantId, runId });

  // 5. Train (HTTP shim to Python)
  currentStep = 'train';
  const trained = await runDocTrainerActivity({ tenantId: input.tenantId, runId, dataS3Uri: exp.s3Uri });

  // 6. Eval gate
  currentStep = 'eval';
  const eva = await evalDocClassifierActivity({ tenantId: input.tenantId, runId, modelS3Uri: trained.modelS3Uri });
  if (!eva.passed) {
    await recordRunActivity({ tenantId: input.tenantId, runId, status: 'failed', /* eval_gate_reasons */ });
    return { runId, promoted: false, reason: 'eval_failed', failures: eva.reasons };
  }

  // 7. If borderline (passed mandatory, missed preferred_lift), require explicit approval signal
  if (eva.borderline && !approval) {
    currentStep = 'awaiting_borderline_approval';
    await notifyAdminReviewActivity({ tenantId: input.tenantId, runId, unreviewedCount: 0, borderline: true });
    await condition(() => approval !== undefined, '7 days');
    if (!approval || approval.action === 'reject') {
      await recordRunActivity({ tenantId: input.tenantId, runId, status: 'failed' });
      return { runId, promoted: false, reason: 'borderline_rejected' };
    }
  }

  // 8. Promote — atomic active flip, S3 alias update
  currentStep = 'promote';
  await promoteDocClassifierActivity({ tenantId: input.tenantId, runId, modelS3Uri: trained.modelS3Uri });

  // 9. Verify hot-reload picked it up
  currentStep = 'verify';
  await verifyHotReloadActivity({ tenantId: input.tenantId, runId, expectedModelUri: trained.modelS3Uri });

  return { runId, promoted: true };
}
```

Cron schedule: weekly (Sundays 03:00 UTC) per tenant.

---

## `classifyDocumentActivity` (modified from 58C)

```typescript
export async function classifyDocumentActivity(input: ClassifyInput): Promise<ClassifyOutput> {
  // 1. Look up active doc_classifier_runs row for tenant; fall back to platform default
  const activeRun = await lookupActiveClassifierRunActivity({ tenantId: input.tenantId });

  // 2. Try sklearn first (cheap)
  const sklearnPred = await callIntentClassifierServiceActivity({
    endpoint: '/predict/doc',
    body: { tenantId: input.tenantId, ocrText: input.ocrText, genericFeatures: input.genericFeatures, fileName: input.fileName, sensitivityTier: input.sensitivityTier },
  });

  const oodThreshold = tunables.doc_classifier_ood_threshold ?? 0.6;
  const useSklearn = sklearnPred.label !== 'unknown_doc_type' && sklearnPred.confidence >= oodThreshold;

  // 3. If sklearn confident, use it; emit telemetry that LLM was skipped
  if (useSklearn) {
    return {
      module: sklearnPred.module,
      docType: sklearnPred.docType,
      confidence: sklearnPred.confidence,
      alternatives: sklearnPred.alternatives,
      evidence: { source: 'sklearn', modelRunId: activeRun.id, predictionId: sklearnPred.predictionId },
    };
  }

  // 4. Fallback: LLM classifier (slice 58C path)
  const llmPred = await callLLMClassifierActivity(input);

  // 5. Telemetry: log sklearn prediction alongside LLM verdict for drift monitoring
  await logPredictionTelemetryActivity({
    tenantId: input.tenantId, documentId: input.documentId,
    sklearnPrediction: sklearnPred, llmPrediction: llmPred, fellBackBecause: 'low_confidence_or_ood',
  });

  return {
    module: llmPred.module, docType: llmPred.docType, confidence: llmPred.confidence,
    alternatives: llmPred.alternatives,
    evidence: { source: 'llm', sklearnFallback: sklearnPred, llmPrompt: llmPred.promptVersion },
  };
}
```

The Langfuse generation includes both predictions — over time we can
compare sklearn-vs-LLM agreement to detect drift.

---

## Tunables

```sql
INSERT INTO bot_tunables (key, value, description, scope) VALUES
  ('documents.classifier.cron_enabled',          'true',  'Enable weekly retrain cron',                'tenant'),
  ('documents.classifier.cron.always_require_approval', 'false', 'Always wait for admin signal before promote', 'tenant'),
  ('documents.classifier.eval.regression_bound', '0.01',  'Max accuracy regression vs baseline',       'global'),
  ('documents.classifier.eval.preferred_lift',   '0.05',  'Required lift to auto-promote',             'global'),
  ('documents.classifier.eval.recall_floor',     '0.70',  'Per-class recall floor',                    'global'),
  ('documents.classifier.eval.min_class_size',   '10',    'Min train rows for a class to be eval-gated','global'),
  ('documents.classifier.eval.p99_ms',           '50',    'Inference p99 ms cap',                      'global'),
  ('documents.classifier.eval.brier_max',        '0.20',  'Confidence calibration Brier score cap',    'global'),
  ('documents.doc_classifier_ood_threshold',     '0.6',   'Min sklearn confidence to use over LLM fallback','tenant'),
  ('documents.classifier.eligibility.min_rows',  '200',   'Min trust-tier-2+ rows to graduate from platform default','tenant'),
  ('documents.classifier.eligibility.min_classes','5',    'Min distinct doc_types in training data',   'tenant')
ON CONFLICT DO NOTHING;
```

---

## MCP tools

### `doc_classifier_retrain`

```
Permission: documents.admin.classifier.retrain
Args:       { forceApprovalRequired?: boolean }
Effect:     Start RetrainDocClassifierWorkflow with trigger='manual'
Returns:    { runId, workflowId }
```

### `doc_classifier_approve`

```
Permission: documents.admin.classifier.retrain
Args:       { runId, action: 'approve'|'reject', note? }
Effect:     temporal.signal('RetrainDocClassifier-{tenantId}-{runId}', 'adminApproval', { ... })
```

### `doc_classifier_rollback`

```
Permission: documents.admin.classifier.retrain
Args:       { fromRunId, toRunId, reason }
Effect:     Atomic flip: active=false on fromRunId, active=true on toRunId.
            Update S3 alias to point at toRunId's model.
            Verify hot-reload picks up.
            Audit.
```

### `doc_classifier_status`

```
Permission: documents.admin.read
Args:       {}
Returns:    {
  activeRun: { runId, promotedAt, accuracy, perClassRecall },
  recentRuns: Array<{ runId, status, candidateAccuracy, promotedAt | failedAt }>,
  driftIndicators: {
    sklearnVsLlmAgreementLast7d: number,           // <0.85 suggests drift
    perClassDriftFlags: Record<string, boolean>,
    avgSklearnConfidence: number,
  },
  trainingData: { totalRows, perClass, perTier, eligible: boolean }
}
```

---

## Acceptance criteria

1. **Bootstrap**: New tenant created. Inference path uses platform
   default model. Verified via `doc_classifier_status`:
   `activeRun.runId == 'platform_default'`.
2. **Eligibility check**: Tenant has 50 trust-tier-2 rows across 3
   classes. `eligibility.eligible=false`. Cron skips this tenant.
3. **Eligibility met → first per-tenant train**: Tenant reaches 200
   tier-2 rows across 6 classes. Cron-triggered run completes:
   eval gate passes, auto-promotes (preferred lift met). Active row
   updated. Hot-reload verified within 5min.
4. **Eval gate regression**: Manually corrupt training data
   (mislabel many rows). Trigger retrain. Eval fails on per-class
   recall. Status `failed`. No promotion. Active row unchanged.
5. **Borderline approval**: Run that passes mandatory but misses
   preferred lift waits for admin signal. Admin approves. Promotes.
6. **OOD fallback**: Upload a doc that's confidently sklearn-predicted
   `unknown_doc_type`. Telemetry shows fallback to LLM.
7. **Rollback**: Promote model run X. Then promote run Y. Then
   rollback to X. Verify active flip + hot-reload + audit row.
8. **Reclassification → training data**: User reclassifies a doc
   from cert.cpr to cert.first_aid. Reclassification approved.
   Next trace import picks up the new (cert.first_aid, tier 3) row.
9. **Workflow_id query during run**: Run a retrain. Query
   `step` while it's in progress. Returns the current step.
10. Langfuse trace tree shows the workflow with each activity as
    a span; Python service emits its own spans for train/eval.

---

## Cross-references

- 58C: classify-document.activity.ts is modified to consult sklearn
  first. Existing LLM path becomes the fallback.
- 58F: reclassification approvals create tier-3 rows in
  `doc_classifier_training_data`. Reclassification workflow's audit
  events drive the trust_tier query.
- 58G: training-data export filters out rows whose source documents
  are soft-purged or hard-purged.
- Slice 56N: this slice mirrors that pattern. If you change one,
  consider whether the other should follow.
