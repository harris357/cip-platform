# Eval harness investigation (2026-05-05)

> **Question:** how do we know if document classification + extraction
> + person-matching is *getting better or worse over time*, per
> `(tenant, module, doc_type)`, with which prompt versions, on which
> input distributions?
>
> Today we can answer **none** of those questions. The signals exist
> on individual rows; nothing aggregates them. This investigation
> defines what aggregation surface we'd need, what's blocking it, and
> what it would take to ship an MVP harness.
>
> **Output**: this note + companion slice draft
> (`SLICE_60_EVAL_HARNESS.md`). Not yet a build commitment — surface
> decisions for review before kickoff.

---

## What signals already exist

### Per-document state (`cip_documents.documents`)

| Field | When populated | What it tells us |
|---|---|---|
| `module`, `doc_type` | classify phase | LLM's pick |
| `classification_confidence` | classify phase | LLM's confidence in its pick |
| `classification_evidence` | classify phase | Raw LLM output, prompt source/version, model alias, tokens used, reasoning |
| `extracted_features` | extract phase | Per-(module, doc_type) field bag (cert: holderName, certNumber, expiryDate, …) |
| `extraction_confidence` | extract phase | Activity-reported overall confidence |
| `subject_employee_id` | post-58D-B | Resolved subject (cert holder for cert flow) |
| `subject_resolution_confidence` | post-58D-B | Confidence the matcher returned |
| `subject_resolution_evidence` | post-58D-B | The matcher's evidence bag — canonicalization output, shortlist, HITL trail (if any) |
| `prior_module`, `prior_doc_type` | post-58F (planned) | What classify said BEFORE a reclassification |
| `reclassification_count` | post-58F | How many times the doc has been reclassified |

### Per-resolution state (`cip_hr.person_match_resolutions`, slice 58D-A)

Rich training-data row per matcher invocation:
- `candidate_text`, `structured_hints` — input
- `canonicalization` — LLM output
- `shortlist` — pg_trgm candidates pre-scoring
- `scored_candidates` — post-scoring shortlist
- `hitl_offered`, `hitl_audience`, `hitl_actor_role`
- `resolved_employee_id`, `resolution_source`, `confidence`, `outcome`
- `evidence` — full trail

This is the **best-shaped corpus on the platform today.** Every match attempt produces one row with full lineage.

### Audit (`cip_documents.audit_events`)

Per-event lifecycle log: `scanned`, `classified`, `extraction_started/completed/failed`, `subject_*`, lifecycle transitions. Time-ordered, queryable.

### LLM observability (Langfuse)

External, but rich: every prompt call has token counts, latency, cost, prompt version, scores (if we add them). Trace IDs link per-document spans.

### Other / partial

- `document_embeddings` — cosine-distance from arbitrary other docs (cluster analysis)
- `layout_fingerprint` — pHash; near-duplicate detection
- `bot_interactions` (existing) — user-facing conversation log
- `cip_hr.training_data` (existing slice 56N) — feedback corpus for the bot's classifier; has nothing for doc classifier yet

---

## What the harness would do

| Question | What we need beyond today |
|---|---|
| **Classifier accuracy** per `(tenant, module, doc_type)` over time | A "ground-truth" label on a doc. Today we have `classification_confidence` but no *correct answer* to compare against. |
| **Did this prompt version regress?** | Prompt version on every classify call (already in `classification_evidence`); a way to filter recent runs by version + report aggregate accuracy. |
| **Field-level extraction accuracy** | Per-field correct/incorrect labels. Today `extraction_confidence` is a single number; we don't know which fields were right. |
| **Person-matcher accuracy** | Which matches were later changed by an admin/uploader → those are wrong. The reclassify path doesn't yet exist for matches (matcher's outcome is final once signaled). Gap. |
| **A/B compare two prompt versions** | Replay-on-demand: re-run classify on a held-out corpus with `prompt_version=N` and `prompt_version=N+1`, diff the outputs. |
| **Holdout-set freezing** | An admin marks docs as "this is canonical correct"; harness re-runs against them whenever code/prompts change. |

The shape of the answer to all of these: **a ground-truth label table joined against the pipeline-output table, aggregated by version + slice + time.**

---

## Where ground-truth labels come from

Three sources, in order of effort and quality:

1. **Implicit corrections (free)** — every reclassification (slice 58F user, 58H admin) is a labeled correction: *"the original prediction was wrong; here's the right answer"*. Captured in `documents.prior_module / prior_doc_type` + the audit event. **First MVP signal.**
2. **Implicit accept (free)** — a doc that reaches `archived` without being reclassified is *probably* correct, but we don't know that for sure (uploader didn't catch the error / admin didn't review). **Weak label; useful as a denominator, not a numerator.**
3. **Explicit annotations (effort)** — admin marks a holdout-set of docs with their correct `(module, doc_type, fields, subject)`. Persistent, replayable. **Best signal but requires admin time.**

The first source is **already produced by the existing pipeline** post-58F/58H and post-58D-A's `person_match_resolutions`. We don't need new write paths to start measuring; we need new read paths.

---

## Discussion points

These are the decisions that shape the slice. Each has a recommendation; you can override.

### D1 — Scope: pure analytics vs. labeled-corpus management vs. replay

| Option | Cost | Value |
|---|---|---|
| **A. Pure analytics (read-only)** — query existing tables, produce reports. No new tables, no new write paths. | ~1 slice (~400 LOC of MCP tools + SQL views) | First number-on-the-board: "classifier ran 1,247 times last week, 87% high-confidence, 23% reclassified." Doesn't catch silent failures. |
| **B. + Labeled-corpus management** — add a `cip_documents.eval_holdout_set` table; admin marks docs as canonical labels; report includes hit-rate against this set. | +1 slice (~600 LOC: schema + MCP tool + admin UI hooks + report extension) | Catches silent failures. Requires sustained admin effort to label. |
| **C. + Replay infrastructure** — re-run classify/extract activities on a fixed corpus with a specific prompt version; diff outputs. | +1 slice (~800 LOC: replay workflow + diff renderer + storage of replay results) | Lets you A/B test prompts before deploy. Heaviest. |

**Recommendation: Start with A. Defer B and C until A produces evidence that prompt regressions are a real problem.** Cheap value first; expand if reads of A justify it.

### D2 — Where the harness lives

| Option | Notes |
|---|---|
| **A. Standalone `@cip/eval-service` package** | Clean separation; new pod; new infra. Heavy for an MVP. |
| **B. Module on doc-service** (`packages/document-service/src/modules/eval/`) | Reuses doc-service's DB connection + MCP server + RLS. Eval queries are mostly against `cip_documents.*`. **Recommended.** |
| **C. Notebook + scripts** | Fastest to iterate but no production surface. |

**Recommendation: B.** Module on doc-service. MCP tools (admin-permission-gated) for the queries; DB views for the heavy lifting; no new pod. Adds ~400 LOC.

### D3 — Cadence: continuous reporting vs. on-demand

| Option | Notes |
|---|---|
| **A. On-demand only** — admin runs `eval_classifier_accuracy` MCP tool, gets results | Simple. No background job. |
| **B. Daily snapshot job (Temporal cron)** — writes `cip_documents.eval_snapshots` rows; trends visible | Time-series capability for "did prompt v3 regress vs v2?" |
| **C. Real-time dashboard** | Out of scope. |

**Recommendation: A for MVP, plan B as a one-week follow-up.** Don't write the cron until at least one MCP tool report exists and a human has run it.

### D4 — Output shape

| Option | Notes |
|---|---|
| **A. Structured JSON (MCP tool returns)** — bot renders adaptive card | Native to the platform. Limited fidelity for big tables. |
| **B. CSV export (S3-backed signed URL)** | Good for ad-hoc analysis. Adds ~50 LOC. |
| **C. Pre-rendered markdown report** | Compromise — readable in Teams. |

**Recommendation: A + B together.** MCP tool returns top-level summary; offers a "download full report" with signed URL. Pattern matches how other admin tools surface heavy outputs.

### D5 — Person-matcher evaluation

The `person_match_resolutions` table is the cleanest corpus we have. But: there's no reclassification path for matches today. If a match was wrong (uploader/admin picked the wrong John), we don't know.

| Option | Notes |
|---|---|
| **A. Skip matcher evaluation in MVP** — only report attempted vs resolved counts and HITL escalation rate | Doesn't measure correctness. Cheap. |
| **B. Add a "match was wrong" feedback path** in cert/HR module workflows — admin can mark a cert's `subject_employee_id` as wrong, retroactively flagging the resolution | New feature; out of scope for harness slice but enables matcher eval. |

**Recommendation: A in MVP.** B becomes a small follow-up slice (~150 LOC: one MCP tool + one column on `person_match_resolutions`) once A is shipped.

### D6 — Slicing dimensions

What do we group reports by? Recommend supporting from MVP:
- `tenant_id`
- `module`, `doc_type`
- `prompt_version` (read from `classification_evidence.promptVersion`)
- `model_alias` (read from `classification_evidence.modelUsed`)
- Time bucket (day/week/month)

Other dimensions (sensitivity tier, MIME class, file size, uploader role) are interesting but not MVP.

---

## Recommendation summary

Ship a small slice (**slice 60**, drafted alongside this note) that:

- Lives as a new module on doc-service: `packages/document-service/src/modules/eval/`.
- Adds 4–5 SQL views in `cip_documents.eval_*` that join existing tables (`documents`, `audit_events`, `document_embeddings`).
- Adds 3 MCP tools, all gated by a NEW permission `documents.admin.eval`:
  - `eval_classifier_summary` — `{tenantId, since, groupBy}` → counts + accuracy proxies
  - `eval_extraction_field_coverage` — per-(module, doc_type) which fields the extractor populated vs. left null
  - `eval_recent_reclassifications` — labeled corrections from the implicit-feedback signal
- Adds a `documents.admin.eval` permission to `permission_catalog`.
- Returns top-line summary inline; offers signed-URL CSV download for full results (one S3 path per report).
- Excludes B (holdout-set table), C (replay), and matcher-correctness — those are follow-ups when the MVP surfaces a real demand.

Estimated ~500 LOC of new code; one cohesive slice, no new pods, no new infrastructure.

---

## Open questions (answer before kickoff)

1. **D1** — Confirm scope is "A only" (pure analytics)? Or fold any of B/C into the MVP?
2. **D2** — Confirm placement on doc-service? Or split out as standalone service from day one?
3. **D5** — Confirm matcher evaluation deferred? Or include the "match was wrong" feedback column in the matcher's existing table now?
4. **CSV download** — confirm signed-URL S3 path matches existing patterns? (Need to check whether doc-service already has an S3 download helper or whether this introduces one.)
5. **Continuous reporting** — confirm "on-demand only" for MVP, daily-snapshot cron deferred? Or wire the cron now while we're touching the schema?
6. **Naming** — `documents.admin.eval` permission OK, or scope by tenant role differently?

If you confirm the recommendations as-is, slice 60 is ready to dispatch as drafted. If you want any of the deferred B/C/D5 work folded in, say which and I'll patch the slice doc before kickoff.
