> **⚠️ SUPERSEDED 2026-05-06 by [SLICE_61](../SLICE_61_REMOVE_INTENT_CLASSIFIER.md).**
> The infrastructure described here was removed in slice 61.
> Doc preserved for history.

# Slice 56B — Training-data lifecycle + model-artifact hot-reload

> Folds three follow-ups to Slices 55/56 into one ship:
>   1. **Rename**: `bot_intent_examples` → `bot_intent_training_data`
>      (the rows are training data, not "examples", and the name needs
>      to read formal in a migration).
>   2. **Lineage**: a `bot_intent_model_runs` table + optional
>      `bot_intent_training_membership` join — so we always know which
>      rows fed which model and which rows are still untrained.
>   3. **Hot-reload**: decouple the joblib artifact from the container
>      image. Trainer uploads to OVH S3; classifier service polls + swaps
>      in-place. Adding one phrase no longer costs an image rebuild.

---

## Why all three together

Each one is small in isolation, but they share migration + tooling
surface (the same scripts read the table, the same trainer produces the
artifact). Splitting forces two table renames, two trainer changes, and
two rounds of script edits. Bundling is one PR.

---

## Decisions locked

| Q | A | Rationale |
|---|---|---|
| Table name | `bot_intent_training_data` | Reads as "the labeled data we train on." Aligns with `training_data.csv` already used by export. No NLP jargon. |
| Per-row `trained_into_model_version` column? | No | Forces UPDATE on every row per train. Lineage via `bot_intent_model_runs.corpus_cutoff_at` answers "untrained since" cheaply with zero write amplification. |
| Exact membership tracking? | Yes — separate join table | Cutoff-by-time gets ~99% but timestamps could be backdated. The membership table is cheap (INSERT…SELECT once per run) and gives an exact audit answer. |
| Model rev = image tag? | No (going forward) | Decouples training cycle from CI cycle. Adding a phrase = train + upload + swap (~30s) instead of rebuild + push + redeploy (~5 min). |
| Per-tenant models? | Not yet | v1 is one platform-wide model. `bot_intent_model_runs` has no `tenant_id` column. Future per-tenant: add the column then. |
| Hot-reload mechanism | Polling | NATS event would be lower latency but adds a dependency for a 60s polling job. Polling is dead simple and the artifact changes maybe twice a day. |
| Bucket name | `cip-platform-models` (single, platform-wide) | Tenant-scoped buckets only make sense once the model is per-tenant. |
| Retrain MCP tool? | Deferred to 56c | Needs an in-cluster trainer job (Helm CronJob or one-shot Job). v1: operator runs `make classifier-train` from workstation. The lifecycle table + hot-reload are independent of trigger mechanism. |

---

## Schema additions

```sql
-- 029_rename_intent_examples_and_add_model_lifecycle.sql

-- 1. Rename. Indexes follow the table per pg semantics; we rename them
--    explicitly so the names match the new table for grep-ability.
ALTER TABLE bot_intent_examples RENAME TO bot_intent_training_data;
ALTER INDEX idx_bot_intent_examples_tenant_unreviewed
  RENAME TO idx_bot_intent_training_data_tenant_unreviewed;
ALTER INDEX idx_bot_intent_examples_added_at
  RENAME TO idx_bot_intent_training_data_added_at;

-- 2. Model run history. One row per `make classifier-train` invocation
--    that produced an artifact.
CREATE TABLE IF NOT EXISTS bot_intent_model_runs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  model_version     TEXT NOT NULL UNIQUE,             -- e.g. 'v1-2026-05-03'
  trained_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  corpus_cutoff_at  TIMESTAMPTZ NOT NULL,             -- rows.added_at <= cutoff were eligible
  train_count       INTEGER NOT NULL,                 -- rows actually included
  intents_count     INTEGER NOT NULL,
  cv_macro_f1       DOUBLE PRECISION,                 -- cross-val score (training-time)
  holdout_macro_f1  DOUBLE PRECISION,                 -- held-out score (eval gate, may be NULL)
  artifact_uri      TEXT NOT NULL,                    -- s3://cip-platform-models/intent-classifier/v1-2026-05-03.joblib
  artifact_sha256   TEXT NOT NULL,
  trainer_git_sha   TEXT,                             -- repo HEAD when trained
  deployed_at       TIMESTAMPTZ,                      -- set when classifier hot-loads it
  deprecated_at     TIMESTAMPTZ,                      -- set when superseded
  notes             TEXT
);

CREATE INDEX IF NOT EXISTS idx_bot_intent_model_runs_trained_at
  ON bot_intent_model_runs (trained_at DESC);

-- 3. Exact membership: which training-data row went into which run.
--    Cheap INSERT once per train; lets us answer "did model v3 see row X?"
--    deterministically.
CREATE TABLE IF NOT EXISTS bot_intent_training_membership (
  model_run_id        UUID NOT NULL REFERENCES bot_intent_model_runs(id) ON DELETE CASCADE,
  training_data_id    UUID NOT NULL REFERENCES bot_intent_training_data(id) ON DELETE CASCADE,
  PRIMARY KEY (model_run_id, training_data_id)
);

CREATE INDEX IF NOT EXISTS idx_bot_intent_training_membership_data
  ON bot_intent_training_membership (training_data_id);

-- 4. Backfill: existing classifier-v1-2026-05-03 artifact predates this
--    table. Synthesize the model run row + membership for the existing
--    47 manual_csv rows so the lineage chain is unbroken.
INSERT INTO bot_intent_model_runs
  (model_version, trained_at, corpus_cutoff_at, train_count, intents_count,
   cv_macro_f1, artifact_uri, artifact_sha256, notes)
VALUES (
  'v1-2026-05-03',
  '2026-05-03T00:00:00Z',
  '2026-05-03T00:00:00Z',
  (SELECT COUNT(*) FROM bot_intent_training_data WHERE source = 'manual_csv'),
  (SELECT COUNT(DISTINCT intent) FROM bot_intent_training_data WHERE source = 'manual_csv'),
  0.346,
  's3://cip-platform-models/intent-classifier/v1-2026-05-03.joblib',
  'baked-in-image-pre-56b',
  'Backfilled at slice 56b — original artifact was image-baked, not S3-resident.'
)
ON CONFLICT (model_version) DO NOTHING;

INSERT INTO bot_intent_training_membership (model_run_id, training_data_id)
  SELECT mr.id, td.id
    FROM bot_intent_model_runs mr
    JOIN bot_intent_training_data td ON td.source = 'manual_csv'
   WHERE mr.model_version = 'v1-2026-05-03'
ON CONFLICT DO NOTHING;
```

---

## Backend changes (TS)

| File | Change |
|---|---|
| `packages/hr-service/src/db/queries/bot-intent-examples.ts` → `.../bot-intent-training-data.ts` | Rename. Add `addModelRun`, `recordTrainingMembership`, `listModelRuns`, `getUntrainedSince`, `markModelDeployed`. |
| `packages/hr-service/src/modules/admin/mcp-tools/bot-intent-examples.tools.ts` → `.../bot-intent-training-data.tools.ts` | Rename. Tool names: `bot_intent_training_data_add`, `bot_intent_training_data_list_unreviewed`. Add `bot_intent_model_runs_list`, `bot_intent_classifier_status` (untrained-row count + latest model). |
| `packages/hr-service/src/modules/admin/mcp-tools/index.ts` | Update imports + register calls. |
| `packages/teams-bot/src/slash-commands/handlers/teach.ts` | Tool name: `bot_intent_example_add` → `bot_intent_training_data_add`. |

---

## Python changes

| File | Change |
|---|---|
| `packages/intent-classifier/requirements.txt` | Add `boto3`, `psycopg[binary]`. |
| `packages/intent-classifier/src/s3_loader.py` (new) | `S3ModelLoader`: poll `s3://<bucket>/<prefix>/CURRENT.json`, download new `.joblib` on version change, atomic swap into `_state`. |
| `packages/intent-classifier/src/classifier.py` | Make `_state` swap atomic (build `bundle` in temp, then assign). Add `swap_in(bundle)` callable. |
| `packages/intent-classifier/src/main.py` | Background asyncio task in `lifespan`: kicks off `S3ModelLoader.start_polling()`. Initial S3 load supersedes the image-baked `.joblib` if newer. |
| `packages/intent-classifier/training/train.py` | After `joblib.dump`, compute SHA256, upload artifact to S3, write `CURRENT.json`, INSERT `bot_intent_model_runs`, INSERT `bot_intent_training_membership` from the `id` set used. |
| `packages/intent-classifier/training/upload.py` (new) | Thin wrapper around boto3 + psycopg. Reads `DATABASE_URL_HR` and `AWS_*` from env. |

### Hot-reload flow

```
trainer (workstation)                S3                     classifier pod (cluster)
─────────────────────                ──                     ────────────────────────
make classifier-train
  ↓
fit + dump local .joblib
  ↓
sha256                               put-object              poll loop (every 60s)
upload artifact          ─────────►  intent-classifier/        GetObject CURRENT.json
                                       v2-2026-05-04.joblib    (HEAD-style ETag check)
update CURRENT pointer   ─────────►  intent-classifier/         ↓
INSERT model_runs                      CURRENT.json          version differs?
INSERT membership                                              ↓
                                                             download artifact
                                                              ↓
                                                             verify sha256
                                                              ↓
                                                             load joblib
                                                              ↓
                                                             swap _state atomically
                                                              ↓
                                                             POST /admin/notify-deployed
                                                             (or just write deployed_at
                                                              from the trainer side
                                                              after the next poll cycle)
```

For v1 we skip the deployed_at callback — operator runs
`make classifier-status` to confirm the swap happened (the tool's
`/healthz` shows the loaded version), and the next train can update
`deployed_at` retroactively if needed.

---

## Helm + secrets

- New secret `intent-classifier-credentials`:
  - `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_ENDPOINT_URL`
- `packages/intent-classifier/helm/values.yaml`: add `envFrom: [{secretRef: {name: intent-classifier-credentials}}]` and env block:
  - `MODEL_S3_BUCKET=cip-platform-models`
  - `MODEL_S3_PREFIX=intent-classifier`
  - `MODEL_POLL_INTERVAL_SEC=60`
  - `AWS_REGION=BHS`
- `scripts/create-secrets.sh`: add the new `kubectl create secret generic intent-classifier-credentials …`.

---

## Scripts + Make

| Script | Change |
|---|---|
| `scripts/training-data-add.sh` | Table name in INSERT. |
| `scripts/training-data-export.sh` | `bot_intent_examples` → `bot_intent_training_data` (3 occurrences). |
| `scripts/training-data-mark-reviewed.sh` | Table name. |
| `scripts/training-data-review.sh` | Table name. |
| `scripts/training-data-stats.sh` | Table name in suggested SQL. |
| `scripts/classifier-status.sh` (new) | Show latest `bot_intent_model_runs` row + count of `bot_intent_training_data` rows added since `corpus_cutoff_at`. |
| `Makefile` | Add `classifier-status` target. Existing `classifier-train` continues to work; behavior change is internal (S3 upload + DB INSERT happen alongside `joblib.dump`). |

---

## Bucket setup

`cip-platform-models` is platform-wide (one bucket for all tenants). The
trainer creates it idempotently via `boto3 create_bucket` (catches
`BucketAlreadyOwnedByYou`). No bootstrap-script change required —
first `make classifier-train` after this slice creates the bucket.

---

## Migration safety

- Migration 029 is **forward-only**. It renames the existing table and
  adds new tables. No data is destroyed.
- The `bot_intent_examples` name is **not** preserved as a view —
  callers are updated in lock-step in this PR. Anything referencing the
  old name will fail loudly post-deploy, which is what we want.
- Backfill of `bot_intent_model_runs` for the existing v1 artifact is
  defensive (`ON CONFLICT DO NOTHING`) — safe to rerun.

---

## Out of scope (future slices)

- **56c**: in-cluster retrain (Helm CronJob or `bot_intent_classifier_retrain` MCP tool).
  Requires a trainer image, a Job spec, and a way to expose the resulting
  artifact path to the operator.
- **56d**: per-tenant models. Adds `tenant_id` to `bot_intent_model_runs`
  and changes the trainer to produce N artifacts.
- **56e**: trace-export auto-labelling — pull successful turns from
  Langfuse, label as `source='trace_export'`, write to
  `bot_intent_training_data` (this is the Langfuse-persistence concern
  that drove the rename in the first place).

---

## Files touched

```
NEW:
  slices/SLICE_56B_TRAINING_DATA_LIFECYCLE.md
  packages/hr-service/src/db/migrations/029_rename_intent_examples_and_add_model_lifecycle.sql
  packages/intent-classifier/src/s3_loader.py
  packages/intent-classifier/training/upload.py
  scripts/classifier-status.sh

RENAMED:
  packages/hr-service/src/db/queries/bot-intent-examples.ts
    → packages/hr-service/src/db/queries/bot-intent-training-data.ts
  packages/hr-service/src/modules/admin/mcp-tools/bot-intent-examples.tools.ts
    → packages/hr-service/src/modules/admin/mcp-tools/bot-intent-training-data.tools.ts

MODIFIED:
  packages/hr-service/src/modules/admin/mcp-tools/index.ts
  packages/teams-bot/src/slash-commands/handlers/teach.ts
  packages/intent-classifier/src/main.py
  packages/intent-classifier/src/classifier.py
  packages/intent-classifier/training/train.py
  packages/intent-classifier/requirements.txt
  packages/intent-classifier/helm/values.yaml
  scripts/training-data-add.sh
  scripts/training-data-export.sh
  scripts/training-data-mark-reviewed.sh
  scripts/training-data-review.sh
  scripts/training-data-stats.sh
  scripts/create-secrets.sh
  Makefile
```

## Verification

After ship:
1. `kubectl rollout restart deploy/hr-service -n cip-app` → migrations run, table renamed
2. `/teach intent=foo next_action=clarify text="bar"` from Teams → row lands in `bot_intent_training_data` (was 'bot_intent_examples')
3. `make training-data-export && make classifier-train` → joblib lands in S3, row lands in `bot_intent_model_runs`, classifier pod logs show `[s3_loader] swapping to v2-…`
4. `make classifier-status` → shows the new run, "0 untrained rows since latest model"
5. Send a phrase the new training data covers but the old artifact didn't — classifier returns it without an LLM hit.
