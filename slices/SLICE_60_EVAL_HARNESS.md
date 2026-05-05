# Slice 60 — evaluation harness MVP (analytics, read-only)

> **Why this exists:** The platform produces rich per-document signal
> (classify confidence + evidence, extract confidence + fields,
> subject resolution + matcher trail, audit events) but **no
> aggregation surface**. We can't answer "is the classifier getting
> better or worse?", "did prompt v3 regress?", or "which (module,
> doc_type) is hitting HITL most?" without querying the production
> DB by hand.
>
> Slice 60 is the **MVP analytics layer** — read-only, no new write
> paths. Five SQL views over existing tables; three MCP tools that
> wrap them; one new permission.
>
> See `EVAL_HARNESS_INVESTIGATION.md` for the full decision log; this
> slice implements the "Option A" recommendation. Holdout-set
> management (Option B), replay infrastructure (Option C), and
> matcher correctness (D5) are deferred to follow-up slices once
> Option A produces evidence justifying them.

---

## Files in scope

```
packages/document-service/src/modules/eval/                         NEW directory
├── mcp-tools/
│   ├── eval-classifier-summary.tool.ts                            NEW (~120 LOC)
│   ├── eval-extraction-field-coverage.tool.ts                     NEW (~90 LOC)
│   ├── eval-recent-reclassifications.tool.ts                      NEW (~90 LOC)
│   └── index.ts                                                   NEW (~15 LOC)
├── queries/
│   └── eval-views.ts                                              NEW (~80 LOC — drizzle wrappers around the views)
└── reports/
    └── csv-export.ts                                              NEW (~70 LOC — generates CSV blob, uploads to S3, returns signed URL)

packages/document-service/src/db/migrations/
└── 013_eval_views.sql                                             NEW (~120 LOC — 5 views; idempotent CREATE OR REPLACE)

packages/document-service/src/db/schema.ts                         MOD (no new tables; views aren't drizzle-tracked)

packages/document-service/src/mcp-server/index.ts                  MOD (register eval module's tools)

packages/hr-service/src/services/permission-catalog-seed.ts        MOD (add documents.admin.eval permission)
```

That's it. ~500 LOC of new code, mostly SQL + thin wrappers. No new tables, no new workers, no new pods.

---

## Hard rules

1. **Read-only.** No `INSERT`, no `UPDATE`. Views over existing
   tables; MCP tools that just SELECT. The eval module never writes
   to `documents`, `audit_events`, or `person_match_resolutions`.

2. **Permission gate.** All three MCP tools require
   `documents.admin.eval` (NEW). No tenant-data leak: the views are
   tenant-scoped via `current_setting('app.current_tenant_id')` per
   the existing RLS pattern.

3. **No tenantId in MCP tool input.** Per non-negotiable #6 — comes
   from `authInfo.token`. Each tool extracts and applies internally.

4. **Top-line + drill-down.** Each tool returns a small structured
   summary inline (renders well in adaptive cards) AND offers a
   `downloadFull: true` arg that returns a signed S3 URL with the
   full result CSV. Mirrors the existing pattern (whichever doc-service
   helper already does signed S3 — check
   `packages/document-service/src/lifecycle/access-policy.ts` or
   wherever fetch-presigned-url logic lives; reuse, don't duplicate).

5. **Reports are queries, not snapshots.** Slice 60 doesn't persist
   a `cip_documents.eval_snapshots` table. Each MCP call recomputes
   from live tables. Snapshot/cron path is a follow-up slice if the
   live-query latency becomes a problem.

6. **No new dependencies.** Drizzle + the existing pg pool. CSV via
   stdlib (`Buffer.from(rows.map(r => csvEscape(r)).join('\n'))`).

---

## SQL views

`013_eval_views.sql` creates 5 views in the `cip_documents` schema.
Each view is RLS-aware (relies on the caller setting
`app.current_tenant_id`).

### `cip_documents.eval_v_classifier_runs`

One row per classify activity invocation. Pulls evidence out of the
`classification_evidence` JSONB:

```sql
CREATE OR REPLACE VIEW cip_documents.eval_v_classifier_runs AS
SELECT
  d.tenant_id,
  d.id                                                          AS document_id,
  d.module,
  d.doc_type,
  d.classification_confidence,
  d.classification_evidence ->> 'promptSource'                  AS prompt_source,
  d.classification_evidence ->> 'promptVersion'                 AS prompt_version,
  d.classification_evidence ->> 'modelUsed'                     AS model_alias,
  (d.classification_evidence ->> 'tokensUsed')::int             AS tokens_used,
  d.classified_at,
  d.lifecycle_state,
  d.reclassification_count,
  d.prior_module,
  d.prior_doc_type
FROM cip_documents.documents d
WHERE d.classified_at IS NOT NULL;
-- Attach RLS by inheritance (views inherit RLS from their underlying tables).
```

### `cip_documents.eval_v_classifier_accuracy_proxy`

Aggregates by `(tenant, module, doc_type, prompt_version, week)`. The
"accuracy proxy" is two columns:

- **High-confidence rate** — `count(confidence >= 0.85) / count(*)`
- **Reclassification rate** — `count(reclassification_count > 0) / count(*)`

Neither is true accuracy without ground-truth labels; both are useful
trends. A spike in reclassification rate after a prompt change is the
signal we're after.

### `cip_documents.eval_v_extraction_field_coverage`

Per `(tenant, module, doc_type)` and per known field, the % of docs
where `extracted_features ->> field IS NOT NULL`. The list of "known
fields per (module, doc_type)" is derived from a small JSON config
in `13_eval_views.sql` (initially: cert's known fields). Docs whose
`(module, doc_type)` isn't in the config are still reported with a
generic "any-field-populated" rate.

### `cip_documents.eval_v_recent_reclassifications`

Joins `documents` with `audit_events` for `event_type='reclassified'`
(post-58F) and surfaces:

```
{tenant_id, document_id, prior_module, prior_doc_type,
 new_module, new_doc_type, reclassified_at, actor_role,
 confidence_at_first_classify, file_name}
```

This IS the implicit-feedback labeled corpus. Each row says: "the
classifier said X; a human said Y." Not yet populated until 58F lands;
the view runs and returns empty in the meantime.

### `cip_documents.eval_v_pipeline_funnel`

Per tenant + week: how many docs entered each lifecycle state.
`scanning → classifying → awaiting_subject → awaiting_routing →
routed → archived`, plus drop-offs to `hitl_admin_queue` and `failed`.
Useful for "last week we had 2x more HITL than the week before — why?"

---

## MCP tools

### `eval_classifier_summary`

```
Permission: documents.admin.eval
Args:       {
              since?:           ISO timestamp (default: 30 days ago)
              groupBy?:         'module' | 'doc_type' | 'prompt_version' | 'week' (default: 'doc_type')
              downloadFull?:    boolean (default: false)
            }
Returns:    {
              periodStart, periodEnd, totalRuns,
              groups: Array<{
                key:                       string,
                runs:                      number,
                avgConfidence:             number,
                highConfidenceRate:        number,
                reclassificationRate:      number,
              }>,
              fullDownloadUrl?: signed S3 URL when downloadFull=true
            }
```

Bounds the inline result to top 20 groups by run count; CSV download
returns all groups for the period.

### `eval_extraction_field_coverage`

```
Permission: documents.admin.eval
Args:       {
              module?:          string (optional filter)
              docType?:         string (optional filter)
              since?:           ISO timestamp (default: 30 days ago)
              downloadFull?:    boolean
            }
Returns:    {
              periodStart, periodEnd,
              perDocType: Array<{
                module, docType,
                runs: number,
                fields: Array<{ name: string, populationRate: number }>
              }>,
              fullDownloadUrl?: signed S3 URL when downloadFull=true
            }
```

Surfaces gaps: "the cert extractor populates `holderName` 98% of the
time but `expiryDate` only 67%." Drives prompt iteration.

### `eval_recent_reclassifications`

```
Permission: documents.admin.eval
Args:       {
              since?:        ISO timestamp (default: 30 days ago)
              limit?:        number (default: 50)
              downloadFull?: boolean
            }
Returns:    {
              count,
              corrections: Array<{
                documentId, fileName,
                prior:    { module, docType, confidence },
                corrected:{ module, docType },
                actorRole, reclassifiedAt
              }>,
              fullDownloadUrl?: signed S3 URL
            }
```

Becomes useful AFTER 58F (uploader reclassify) or 58H (admin
reclassify) lands. Until then, returns empty arrays — that's fine, it
proves the pipe works.

---

## Permission

Add to `permission-catalog-seed.ts`:

```typescript
{ service: 'document-service', module: 'documents', permission: 'documents.admin.eval',
  description: 'Read aggregate evaluation reports (classifier accuracy proxies, field coverage, reclassification trends)' },
```

Granted to platform admins / HR admins; not to regular users.

---

## CSV export pattern

`reports/csv-export.ts`:

1. Format rows as RFC-4180 CSV (one helper, ~30 LOC; quote, escape, newline).
2. Upload to `s3://{bucket}/eval-reports/{tenantId}/{reportType}-{timestamp}.csv` with 7-day expiry on the bucket.
3. Generate a signed GET URL (15-minute TTL).
4. Return URL.

Uses the existing `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` already in `package.json`. No new dependencies.

---

## Acceptance criteria

1. **Three MCP tools register and are listable via `tools/list` for actors with `documents.admin.eval`.** Actors without the permission see them filtered out.

2. **`eval_classifier_summary` against the development DB returns sensible numbers** for a tenant with at least 10 classified docs. `totalRuns` matches `SELECT count(*) FROM documents WHERE classified_at IS NOT NULL AND tenant_id = $1`.

3. **`eval_extraction_field_coverage` for `module='certificate'`** lists the known cert fields (holderName, certNumber, issueDate, expiryDate) with population rates ∈ [0, 1].

4. **`eval_recent_reclassifications`** returns an empty array on a development DB (since 58F isn't shipped). The query plan executes; no errors.

5. **`downloadFull: true`** on any of the three tools returns a JSON object with a `fullDownloadUrl` whose contents fetch as a valid CSV (header row + data rows, RFC-4180-compliant).

6. **Tenant isolation.** A user with `documents.admin.eval` on tenant A cannot read tenant B's reports. Verify via the existing RLS test pattern (`grep "withTenantRLS\|setTenantContext" packages/document-service/test/`).

7. **`pnpm -r run typecheck` clean.**

8. **`pnpm --filter @cip/document-service test`** passes; new tests cover at least the CSV escaping helper + one end-to-end view query (against a Postgres test fixture if one exists).

---

## Test plan

- Unit: `csvEscape()` covers commas, quotes, newlines, unicode.
- Unit: each MCP tool's argument parsing + permission check (mock the DB).
- Integration (local DB): seed 30 documents with varying module/doc_type/confidence; run each tool; assert structure of returned summary.

---

## Forward refs (separate slices, not part of 60)

- **Slice 60-B (Option B)** — `cip_documents.eval_holdout_set` table; admin marks docs as canonical labels; reports include hit-rate against this set. Trigger: when 60's reports show a prompt regression we couldn't detect from implicit feedback alone.
- **Slice 60-C (Option C)** — replay infrastructure: re-run classify on a corpus with a chosen prompt version; diff outputs. Trigger: when prompt changes start needing pre-deploy validation.
- **Slice 60-D (matcher correctness)** — feedback path for "match was wrong"; new column on `person_match_resolutions`. Trigger: when matcher accuracy is suspect and we want to measure it.
- **Slice 60-E (continuous reporting)** — daily-snapshot cron writing `cip_documents.eval_snapshots` rows. Trigger: when on-demand queries become slow OR the team wants Slack alerts on regressions.

Each is small (~300–500 LOC) and uses 60's primitives. Defer until evidence justifies.

---

## Risk

- **Risk**: queries against `documents` + `audit_events` JSONB columns are slow at production scale.
  - **Mitigation**: views are simple SELECTs with WHERE on indexed columns (tenant_id, classified_at, lifecycle_state). JSONB extractions are postfix-cheap. If a view becomes a hot path, the snapshot/cron slice (60-E) is the answer.
- **Risk**: `classification_evidence` JSONB shape might differ across prompt versions.
  - **Mitigation**: the view uses `->>` (returns text or NULL); missing keys return NULL; aggregations skip them gracefully.
- **Risk**: CSV download via signed URL leaks if the bucket is misconfigured.
  - **Mitigation**: uses the existing bucket + IAM policy already in production; 15-min TTL on the signed URL.
