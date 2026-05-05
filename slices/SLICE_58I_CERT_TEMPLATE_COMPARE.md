# Slice 58I — cert template-and-compare

> **Why this exists:** User's stated downstream goal. Once cert
> docs accumulate, build canonical templates per cert type
> (Red Cross CPR, AHA First Aid, OSHA HAZWOPER, etc.) and compare
> new submissions against the canonical template field-by-field.
> Catches tampering, layout deviations, and lets HITL reviewers see
> exactly where a doc differs from the standard ("expiry date is 8
> years out — only valid for 2"). Builds on 58B's L1+L2 features
> + 58C's L3 cert extraction.
>
> Cert-module-specific. Sets the precedent for any future module
> wanting template-and-compare (per-module, per-doc_type).

---

## Architectural shift — templates are first-class

Until 58I, classification + extraction operate on the doc in
isolation. 58I introduces the concept of a **canonical template**
that the doc is compared against. Three new capabilities:

1. **Field-rule comparison** — schema validation against doc-type-specific rules
2. **Layout-and-embedding similarity gating** — does this doc actually look like the template?
3. **Auto-derived templates** — clustering on existing docs to bootstrap templates without manual definition

Two surfaces own template state:
- `cip_documents.document_templates` — layout side (tenant-scoped, reusable across modules)
- `cip_hr.cert_template_field_definitions` — cert-module-specific field rules

This split keeps doc-service from owning module business logic
(field rules) while still owning the layout/embedding fingerprints.

---

## Files in scope

```
packages/document-service/src/modules/templates/                       NEW directory
├── workflows/
│   ├── derive-template.workflow.ts                                    NEW (clustering job: pick centroid, suggest template)
│   └── index.ts                                                       NEW
├── activities/
│   ├── cluster-by-fingerprint.activity.ts                             NEW (DBSCAN over fingerprint + embedding distances)
│   ├── compute-cluster-centroid.activity.ts                           NEW (pick representative doc per cluster)
│   ├── select-matching-template.activity.ts                           NEW (called by cert workflow at compare time)
│   ├── compare-to-template.activity.ts                                NEW (the diff producer)
│   ├── record-template-match.activity.ts                              NEW (audit `template_matched` event)
│   └── index.ts                                                       NEW
└── mcp-tools/
    ├── cert-template-list.tool.ts                                     NEW (admin: list templates for a module/doc_type)
    ├── cert-template-define.tool.ts                                   NEW (admin: register a canonical template manually)
    ├── cert-template-derive.tool.ts                                   NEW (admin: trigger DeriveTemplateWorkflow)
    ├── cert-template-update-field-rules.tool.ts                       NEW (admin: edit field rule schema)
    ├── cert-template-supersede.tool.ts                                NEW (admin: mark v_old superseded by v_new)
    └── index.ts                                                       NEW

packages/hr-service/src/modules/certifications/                       MOD
├── workflows/
│   └── certification-processing.workflow.ts                          MOD (after extract: selectMatchingTemplate → compareToTemplate → HITL on anomalies)
├── activities/
│   ├── compare-to-template.activity.ts                               NEW (cert-module wrapper around doc-service activity for per-field rule eval)
│   └── index.ts                                                      MOD

packages/teams-bot/src/intent/
└── cert-template-diff-card.ts                                        NEW (HITL adaptive card)

packages/document-service/src/db/migrations/
├── 017_document_templates.sql                                        NEW
└── 018_template_match_events.sql                                     NEW (per-doc match results; for drift monitoring)

packages/hr-service/src/db/migrations/
└── 046_cert_template_field_definitions.sql                           NEW

packages/hr-service/src/services/permission-catalog-seed.ts           MOD (add documents.admin.template.write to the catalog)
```

---

## Hard rules

1. **Templates are versioned** with `valid_from` / `valid_until` /
   `superseded_by`. Old templates are NEVER deleted — needed for
   historical comparison.
2. **Per-tenant overrides platform-default**. Resolution at compare
   time: tenant-scoped templates first, then platform-default
   (tenant_id = `00000000-0000-0000-0000-000000000000`).
3. **Match threshold is composite**, not single-axis.
   `composite = 0.6 * layout_similarity + 0.4 * embedding_similarity`.
   Below 0.85 (tunable) = no template match; cert workflow proceeds
   without template comparison.
4. **Auto-derive templates require admin approval** before insertion.
   The workflow surfaces a clustering result; admin reviews each
   suggestion individually.
5. **Field rules live in cert module**, not doc-service. Doc-service
   owns layout/embedding fingerprints only. Keeps modular boundary.
6. **All matches and anomalies audited** to `audit_events` (existing
   `template_matched` event_type from 58A) AND a per-match record
   in new `template_match_events` table for drift monitoring.
7. **Multi-template match** resolves by highest composite score;
   tie → most recent `valid_from`.
8. **Workflow ID convention** for derive:
   `DeriveTemplate-${tenantId}-${requestId}`.
9. **Activity output Zod-parsed** before persistence.

---

## Schemas

### `cip_documents.document_templates`

```sql
CREATE TABLE cip_documents.document_templates (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                UUID NOT NULL,                                  -- '00000000-...' = platform default
  module                   TEXT NOT NULL,                                  -- 'certificate'
  doc_type                 TEXT NOT NULL,                                  -- 'certificate.cpr'
  label                    TEXT NOT NULL,                                  -- 'Red Cross CPR Card v2024'
  version                  INT NOT NULL DEFAULT 1,                         -- monotonic per (tenant, module, doc_type, label_root)
  layout_fingerprint       TEXT NOT NULL,                                  -- canonical pHash
  embedding                vector(1024),                                   -- canonical text embedding
  reference_document_ids   UUID[] NOT NULL DEFAULT '{}',                   -- exemplars used to derive
  valid_from               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  valid_until              TIMESTAMPTZ,                                    -- null = current
  superseded_by            UUID,                                           -- FK to next version (nullable)
  override_platform_default BOOLEAN NOT NULL DEFAULT false,
  enabled                  BOOLEAN NOT NULL DEFAULT true,
  derived_via              TEXT NOT NULL CHECK (derived_via IN ('manual','auto_clustered','imported')),
  derive_run_id            UUID,                                           -- which DeriveTemplate workflow run produced this
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by               UUID,
  UNIQUE (tenant_id, module, doc_type, label, version)
);
CREATE INDEX dt_resolution_idx ON cip_documents.document_templates(tenant_id, module, doc_type, enabled, valid_from DESC) WHERE valid_until IS NULL;
```

### `cip_hr.cert_template_field_definitions`

```sql
CREATE TABLE cip_hr.cert_template_field_definitions (
  template_id              UUID NOT NULL,                                  -- references document_templates.id
  field_name               TEXT NOT NULL,
  field_type               TEXT NOT NULL CHECK (field_type IN ('date','string','enum','regex','number','composite')),
  required                 BOOLEAN NOT NULL DEFAULT true,
  validator_config         JSONB NOT NULL,
  severity_override        TEXT CHECK (severity_override IN ('low','medium','high','critical')),
  description              TEXT,
  display_order            INT NOT NULL DEFAULT 0,
  PRIMARY KEY (template_id, field_name)
);
```

### `cip_documents.template_match_events`

Per-match record for drift monitoring (separate from `audit_events`
which is the canonical timeline; this table is a thin OLAP-friendly
slice):

```sql
CREATE TABLE cip_documents.template_match_events (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                UUID NOT NULL,
  document_id              UUID NOT NULL,
  template_id              UUID,                                           -- null if no match
  layout_similarity        DOUBLE PRECISION,
  embedding_similarity     DOUBLE PRECISION,
  composite_score          DOUBLE PRECISION,
  overall_severity         TEXT,                                           -- 'none'|'low'|'medium'|'high'|'critical'
  anomaly_count            INT NOT NULL DEFAULT 0,
  recommendation           TEXT,                                           -- 'approve'|'hitl_required'|'reject'
  diff_payload             JSONB,                                          -- the full FieldDiff[]
  matched_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX tme_doc_idx ON cip_documents.template_match_events(tenant_id, document_id, matched_at DESC);
CREATE INDEX tme_template_idx ON cip_documents.template_match_events(tenant_id, template_id, matched_at DESC) WHERE template_id IS NOT NULL;
```

---

## Match resolution algorithm (`selectMatchingTemplateActivity`)

```typescript
export async function selectMatchingTemplateActivity(input: {
  tenantId: string; module: string; docType: string;
  documentLayoutFingerprint: string;
  documentEmbedding: number[];
}): Promise<{ matched: boolean; template?: DocumentTemplate; layoutSimilarity?: number; embeddingSimilarity?: number; compositeScore?: number }> {

  const matchThreshold = await getTunable('documents.cert_template.match_threshold');   // default 0.85
  const layoutWeight   = await getTunable('documents.cert_template.layout_weight');     // default 0.6
  const embeddingWeight = 1 - layoutWeight;

  // 1. Resolve eligible templates: per-tenant first, then platform default
  const tenantTemplates = await listEligibleTemplatesActivity({
    tenantId: input.tenantId, module: input.module, docType: input.docType,
  });
  const platformTemplates = await listEligibleTemplatesActivity({
    tenantId: PLATFORM_DEFAULT_TENANT_ID, module: input.module, docType: input.docType,
  });

  // 2. Build candidate set with override semantics
  const overriddenLabels = new Set(tenantTemplates.filter(t => t.overridePlatformDefault).map(t => t.label));
  const platformFiltered = platformTemplates.filter(t => !overriddenLabels.has(t.label));
  const candidates = [...tenantTemplates, ...platformFiltered].filter(t => t.enabled && (t.validUntil === null || t.validUntil > new Date()));

  // 3. Score each candidate
  const scored = candidates.map(t => {
    const layoutSim = layoutSimilarity(input.documentLayoutFingerprint, t.layoutFingerprint);
    const embSim = cosineSimilarity(input.documentEmbedding, t.embedding);
    const composite = layoutWeight * layoutSim + embeddingWeight * embSim;
    return { template: t, layoutSimilarity: layoutSim, embeddingSimilarity: embSim, composite };
  });

  // 4. Filter by threshold; pick best
  const above = scored.filter(s => s.composite >= matchThreshold);
  if (above.length === 0) {
    return { matched: false };
  }
  const winner = above.sort((a, b) =>
    b.composite - a.composite ||
    (b.template.validFrom.getTime() - a.template.validFrom.getTime())
  )[0];

  return {
    matched: true,
    template: winner.template,
    layoutSimilarity: winner.layoutSimilarity,
    embeddingSimilarity: winner.embeddingSimilarity,
    compositeScore: winner.composite,
  };
}

function layoutSimilarity(a: string, b: string): number {
  // Hamming distance over hex pHash strings, normalized to [0, 1]
  // 256-bit pHash → 64 hex chars; assume both same length
  if (a.length !== b.length) return 0;
  let differing = 0;
  for (let i = 0; i < a.length; i++) {
    const xa = parseInt(a[i], 16), xb = parseInt(b[i], 16);
    differing += popcount(xa ^ xb);
  }
  return 1 - differing / (a.length * 4);
}
```

---

## `compareToTemplateActivity` (cert-side)

Doc-service surfaces "did template match"; cert module owns the
field-rule evaluation:

```typescript
// packages/hr-service/src/modules/certifications/activities/compare-to-template.activity.ts
export async function compareToTemplateActivity(input: {
  tenantId: string;
  certSubmissionId: string;
  templateId: string;
  extractedFeatures: Record<string, unknown>;
  layoutSimilarity: number;
  embeddingSimilarity: number;
}): Promise<TemplateComparisonResult> {
  const fieldRules = await loadFieldDefinitionsActivity({ templateId: input.templateId });

  const fieldDiffs: FieldDiff[] = [];
  const anomalies: Anomaly[] = [];

  for (const rule of fieldRules) {
    const found = input.extractedFeatures[rule.fieldName];
    const diff: FieldDiff = {
      fieldName: rule.fieldName, expectedRule: rule, foundValue: found,
      status: 'valid', severity: 'low',
    };

    if (rule.required && (found === undefined || found === null || found === '')) {
      diff.status = 'missing_required'; diff.severity = rule.severityOverride ?? 'high';
      anomalies.push({ type: 'missing_required_field', severity: diff.severity, details: { fieldName: rule.fieldName } });
    } else if (found !== undefined) {
      const eval_ = evaluateFieldRule(rule, found);
      if (!eval_.valid) {
        diff.status = eval_.status; diff.severity = rule.severityOverride ?? eval_.severity;
        anomalies.push({ type: eval_.status, severity: diff.severity, details: { fieldName: rule.fieldName, ...eval_.details } });
      }
    }

    fieldDiffs.push(diff);
  }

  // Layout-side anomalies
  const layoutThreshold = 0.85;
  if (input.layoutSimilarity < layoutThreshold) {
    anomalies.push({ type: 'layout_mismatch', severity: 'medium', details: { score: input.layoutSimilarity } });
  }
  if (input.embeddingSimilarity < 0.7 && input.layoutSimilarity >= layoutThreshold) {
    anomalies.push({ type: 'embedding_drift', severity: 'medium', details: { score: input.embeddingSimilarity } });
  }
  if (anomalies.filter(a => a.severity === 'high').length >= 3) {
    anomalies.push({ type: 'composite_failure', severity: 'critical', details: { highSeverityCount: anomalies.filter(a => a.severity === 'high').length } });
  }

  const overallSeverity = pickMaxSeverity(anomalies);
  const recommendation = overallSeverity === 'critical' ? 'reject'
                       : (overallSeverity === 'high' || overallSeverity === 'medium') ? 'hitl_required'
                       : 'approve';

  return TemplateComparisonResultSchema.parse({
    templateId: input.templateId,
    templateLabel: /* loaded from template */,
    layoutSimilarity: input.layoutSimilarity,
    embeddingSimilarity: input.embeddingSimilarity,
    fieldDiffs, anomalies,
    overallSeverity, recommendation,
  });
}
```

`evaluateFieldRule` is a small pure function dispatching on
`field_type`:
- `regex`: test pattern against found value
- `date`: parse format; check validity period bound (`now() − issued ≤ validity_period_years`)
- `enum`: membership
- `number`: range bounds
- `composite`: recursive AND/OR over sub-rules

---

## Cert workflow integration

In `CertificationProcessingWorkflow` (rewritten in 58E), insert
between extract and persist:

```typescript
// After validateExtractionActivity:

const matchResult = await selectMatchingTemplateActivity({
  tenantId, module: 'certificate', docType: input.docType,
  documentLayoutFingerprint: input.genericFeatures.layout_fingerprint,
  documentEmbedding: await fetchEmbeddingActivity({ tenantId, documentId: input.documentId }),
});

let templateAnomalies: Anomaly[] = [];
let comparisonResult: TemplateComparisonResult | undefined;

if (matchResult.matched) {
  comparisonResult = await compareToTemplateActivity({
    tenantId, certSubmissionId,
    templateId: matchResult.template!.id,
    extractedFeatures: input.extractedFeatures,
    layoutSimilarity: matchResult.layoutSimilarity!,
    embeddingSimilarity: matchResult.embeddingSimilarity!,
  });

  await recordTemplateMatchActivity({
    tenantId, documentId: input.documentId,
    templateId: matchResult.template!.id,
    result: comparisonResult,
  });

  templateAnomalies = comparisonResult.anomalies;

  if (comparisonResult.recommendation === 'reject' && tunables.auto_reject_on_critical) {
    // Critical anomaly + tunable allows auto-reject
    await rejectCertSubmissionActivity({ tenantId, certSubmissionId, reason: 'template_critical_anomaly', anomalies: templateAnomalies });
    await signalDocumentServiceCallback({ tenantId, documentId: input.documentId, moduleRecordId: certSubmissionId, status: 'rejected', rejectionReason: 'template_critical_anomaly' });
    return;
  }
}

const needsHitl =
  input.extractedFeatures.overallConfidence < 0.85 ||
  certMatch.confidence < 0.7 ||
  (comparisonResult && comparisonResult.recommendation === 'hitl_required');

if (needsHitl) {
  await notifyHitlActivity({
    tenantId, certSubmissionId,
    hitlReasonCode: comparisonResult?.recommendation === 'hitl_required' ? 'template_anomaly' : 'low_confidence',
    payload: { comparisonResult, extraction: input.extractedFeatures },
  });
  await condition(() => hitlDecision !== undefined, '7 days');
}

// Continue with persist + downstream callback as in 58E.
```

---

## `DeriveTemplateWorkflow` — auto-derive

Triggered by admin via `cert_template_derive` MCP tool. Walks past
docs in `(tenant, module, doc_type)`, clusters, surfaces suggestions:

```typescript
export async function DeriveTemplateWorkflow(input: {
  tenantId: string; module: string; docType: string; lookbackDays?: number;
  triggeredBy: string;
}): Promise<{ suggestions: ClusterSuggestion[] }> {

  // Workflow ID pattern: {workflowType}-{tenantId}-{entityId}
  // workflowId: `DeriveTemplate-${input.tenantId}-${randomUUID()}`

  const lookback = input.lookbackDays ?? 90;

  // 1. Pull eligible docs (routed/archived in window)
  const docs = await listEligibleDocsActivity({
    tenantId: input.tenantId, module: input.module, docType: input.docType, lookbackDays: lookback,
  });

  if (docs.length < 5) {
    return { suggestions: [] };                      // not enough to cluster meaningfully
  }

  // 2. Compute pairwise composite distances (sequential scan over <500 docs is fine)
  const distances = await computePairwiseDistancesActivity({ docs });

  // 3. DBSCAN cluster
  const clusters = await clusterByFingerprintActivity({ distances, eps: 0.15, minSamples: 5 });

  // 4. For each cluster, pick centroid + suggest as template
  const suggestions: ClusterSuggestion[] = [];
  for (const cluster of clusters) {
    const centroid = await computeClusterCentroidActivity({ cluster });
    suggestions.push({
      clusterSize: cluster.documentIds.length,
      centroidDocumentId: centroid.documentId,
      centroidLayoutFingerprint: centroid.layoutFingerprint,
      centroidEmbedding: centroid.embedding,
      averageInternalDistance: cluster.averageDistance,
      sampleFilenames: cluster.documentIds.slice(0, 5).map(id => id),
    });
  }

  // 5. Notify admin via card surface — admin reviews each cluster individually
  await notifyAdminClusterSuggestionsActivity({
    tenantId: input.tenantId, requestedBy: input.triggeredBy,
    suggestions,
  });

  return { suggestions };
}
```

Admin then uses `cert_template_define` for each cluster they want
to materialize as a template, supplying label + field rules.

---

## Tunables

```sql
INSERT INTO bot_tunables (key, value, description, scope) VALUES
  ('documents.cert_template.match_threshold',          '0.85', 'Composite score threshold for template match',     'tenant'),
  ('documents.cert_template.layout_weight',            '0.6',  'Weight on layout similarity in composite',         'tenant'),
  ('documents.cert_template.auto_reject_on_critical',  'true', 'Auto-reject submission on critical anomaly',       'tenant'),
  ('documents.cert_template.derive_lookback_days',     '90',   'Days back to consider when auto-deriving',         'tenant'),
  ('documents.cert_template.derive_min_cluster_size',  '5',    'Min docs in a cluster to suggest a template',      'tenant'),
  ('documents.cert_template.derive_dbscan_eps',        '0.15', 'DBSCAN eps parameter',                             'tenant')
ON CONFLICT DO NOTHING;
```

---

## MCP tools

### `cert_template_list`

```
Permission: documents.admin.read
Args:       { module?: 'certificate', docType?: string, includeSuperseded?: boolean }
Returns:    Array<DocumentTemplate>  // joined with field_count from cert_template_field_definitions
```

### `cert_template_define`

```
Permission: documents.admin.template.write
Args:       {
  module: 'certificate',
  docType: string,
  label: string,
  referenceDocumentIds: UUID[],          // doc-service derives layout_fingerprint + embedding from these
  fieldRules: Array<{                    // cert-side field schema
    fieldName: string, fieldType: 'date'|'string'|'enum'|'regex'|'number'|'composite',
    required: boolean, validatorConfig: object, severityOverride?: 'low'|'medium'|'high'|'critical',
  }>,
  validFrom?: Date,
  overridePlatformDefault?: boolean,
}
Effect:     Inserts document_templates row + N cert_template_field_definitions rows in one transaction.
            Audit: template_defined.
```

### `cert_template_derive`

```
Permission: documents.admin.template.write
Args:       { module: 'certificate', docType: string, lookbackDays? }
Effect:     Starts DeriveTemplateWorkflow.
            Returns workflowId; admin polls or receives the suggestions card.
```

### `cert_template_update_field_rules`

```
Permission: documents.admin.template.write
Args:       { templateId, fieldRules: Array<...> }
Effect:     Replace field rule set for an existing template (creates a new template version vs in-place edit?).
            DECISION: create a new version (incremented). Keeps prior version available for historical comparison.
```

### `cert_template_supersede`

```
Permission: documents.admin.template.write
Args:       { oldTemplateId, newTemplateId, validFromOverride?: Date }
Effect:     UPDATE old SET valid_until = NOW(), superseded_by = newTemplateId
            UPDATE new SET valid_from = NOW() (or override)
            Audit: template_superseded.
```

---

## HITL diff card

Bot adaptive card (rendered by `cert-template-diff-card.ts`):

```
🔍 Template Match: Red Cross CPR v2024 — similarity 0.92

| Field           | Expected             | Found                | Status              |
| --------------- | -------------------- | -------------------- | ------------------- |
| cert_number     | regex `RC-\d{6}`     | RC-123456            | ✅ valid            |
| holder_name     | required             | Jane Smith           | ✅ valid            |
| issue_date      | required             | 2025-03-15           | ✅ valid            |
| expiry_date     | within 2y of issue   | 2030-03-15           | ❌ value_violation  |
| issuer          | enum: [Red Cross]    | American Red Cross   | ❌ value_out_of_enum|

Anomalies: 2 high-severity. Recommendation: HITL required.

[Approve as-is]   [Reject]   [Edit fields]   [Update template]
```

Verbs:
- `cert.template.diff.approve` → cert workflow proceeds with extracted values; signal hitlDecision='approve'
- `cert.template.diff.reject` → cert submission rejected; signal hitlDecision='reject', reason='template_anomaly'
- `cert.template.diff.edit` → opens an Adaptive Card task module pre-filled with extracted values; admin edits; saves → cert proceeds with edited values
- `cert.template.diff.update_template` → opens cert_template_update_field_rules path (e.g. "issuer enum should also include 'American Red Cross'")

---

## Acceptance criteria

1. **Manual template definition**: Admin defines `Red Cross CPR
   v2024` template with 5 field rules, referencing 3 sample docs.
   Verify document_templates row + 5 cert_template_field_definitions
   rows.
2. **Clean match → auto-approve**: Submit a clean CPR cert that
   matches the template (composite ≥ 0.9, all fields valid). Cert
   workflow proceeds without HITL.
3. **Field anomaly → HITL**: Submit a CPR cert with expiry date 5
   years out (validity is 2y). Anomaly raised. HITL fires with diff
   card. Admin clicks "Reject" → cert workflow signals reject to
   doc-service workflow.
4. **Layout mismatch → HITL**: Submit a CPR cert with very different
   layout (composite < 0.85). No template matches; cert proceeds
   without template comparison. Audit shows
   `template_match_events.template_id=null`.
5. **Multi-version match resolution**: Define v2024 (valid_from
   2024-01-01) and v2025 (valid_from 2025-01-01). Submit a doc
   classified after 2025-01-01: matches v2025. Submit a doc with
   `classified_at=2024-06-15`: should match v2024 if we filter by
   classified_at being within valid range. **Decision: at compare
   time we use NOW(), not the doc's classified_at.** The
   most-recent-applicable wins.
6. **Auto-derive**: Tenant has 50 routed CPR docs with similar
   layouts. Run `cert_template_derive`. Receive 1-2 cluster
   suggestions. Admin defines a template from one of them. Verify
   `derived_via='auto_clustered'` and `derive_run_id` set.
7. **Platform-default + tenant override**: Platform default
   "Red Cross CPR v2024" exists. Tenant defines own override with
   `override_platform_default=true`. Tenant docs match the override
   instead.
8. **Critical auto-reject**: Submit a doc with 4 high-severity
   anomalies (composite_failure → critical). Tunable
   `auto_reject_on_critical=true`. Cert auto-rejects without HITL.
9. **Supersede**: Define v2024, then v2025 superseding it. Verify
   v2024.valid_until set to v2025.valid_from. Old docs still match
   v2024 (if their ranges fall in it). New docs match v2025.

---

## Cross-references

- 58B: layout_fingerprint + embedding are computed for every doc.
  This slice consumes them.
- 58C: extracted_features for cert docs are the input to
  field-rule evaluation.
- 58E: cert workflow gains template comparison as a step in its
  middle. Doesn't change the input contract from doc-service.
- 58F: reclassification could change a doc's matched template
  (different doc_type → different template set). Reclassify clears
  template_match_events for that doc; new comparison runs after
  re-classify.
- 58H: template-match drift (composite scores trending down
  month-over-month) is a strong signal that field rules need
  updating, OR that a new template version is emerging in the
  wild. Future slice could auto-trigger DeriveTemplate when drift
  detected.
