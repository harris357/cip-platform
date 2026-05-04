-- Slice 56B: rename bot_intent_examples → bot_intent_training_data,
-- and add model-run lineage tables.
--
-- WHY THE RENAME:
--   The rows aren't "examples" anymore — they're production training
--   data, sourced from /teach (admins), turn-label, manual CSV import,
--   and (Slice 56e) Langfuse trace exports. The new name reads formal
--   in a migration and aligns with `training_data.csv` already used by
--   `make training-data-export`.
--
-- WHY THE LINEAGE TABLES:
--   - bot_intent_model_runs: one row per `make classifier-train` that
--     produced an artifact. Carries cv/holdout F1, S3 URI, sha256, the
--     trainer's HEAD git SHA, and corpus_cutoff_at — the timestamp the
--     trainer used to bound which training rows were eligible.
--   - bot_intent_training_membership: exact join of which training-data
--     row went into which model run. Cheap to populate (one INSERT…SELECT
--     after fit), gives a deterministic answer to "did model v3 see row X?"
--     that the corpus_cutoff_at heuristic can't (timestamps could be
--     backdated).
--
-- Forward-only. No view alias for the old name — callers are updated in
-- lock-step in this slice's PR. Anything still referencing
-- bot_intent_examples will fail loudly post-deploy, which is intended.

BEGIN;

-- 1. Rename the table + indexes. Indexes follow the table per pg
--    semantics; we rename them explicitly so names match the new table
--    for grep-ability.
ALTER TABLE bot_intent_examples RENAME TO bot_intent_training_data;

ALTER INDEX idx_bot_intent_examples_tenant_unreviewed
  RENAME TO idx_bot_intent_training_data_tenant_unreviewed;
ALTER INDEX idx_bot_intent_examples_added_at
  RENAME TO idx_bot_intent_training_data_added_at;

-- 2. Model run history. Platform-wide (no tenant_id) for v1 — one model
--    serves all tenants. If we ever go per-tenant (Slice 56d), add the
--    column then.
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

-- 3. Exact membership: one row per (model_run, training_data) pair.
--    Cheap INSERT once per train; deterministic audit.
CREATE TABLE IF NOT EXISTS bot_intent_training_membership (
  model_run_id        UUID NOT NULL REFERENCES bot_intent_model_runs(id) ON DELETE CASCADE,
  training_data_id    UUID NOT NULL REFERENCES bot_intent_training_data(id) ON DELETE CASCADE,
  PRIMARY KEY (model_run_id, training_data_id)
);

CREATE INDEX IF NOT EXISTS idx_bot_intent_training_membership_data
  ON bot_intent_training_membership (training_data_id);

-- 4. Backfill: the existing classifier-v1-2026-05-03 artifact predates
--    this table. Synthesize the run row + membership for the existing
--    47 manual_csv rows so the lineage chain is unbroken from the start.
--
--    artifact_sha256 is set to a sentinel — the original artifact was
--    image-baked, never hashed. Future runs will populate the real hash.
INSERT INTO bot_intent_model_runs
  (model_version, trained_at, corpus_cutoff_at, train_count, intents_count,
   cv_macro_f1, artifact_uri, artifact_sha256, notes)
VALUES (
  'v1-2026-05-03',
  '2026-05-03T00:00:00Z',
  '2026-05-03T00:00:00Z',
  COALESCE((SELECT COUNT(*)::INTEGER FROM bot_intent_training_data WHERE source = 'manual_csv'), 0),
  COALESCE((SELECT COUNT(DISTINCT intent)::INTEGER FROM bot_intent_training_data WHERE source = 'manual_csv'), 0),
  0.346,
  -- Image-baked artifact predates the S3 lifecycle, so the URI is a
  -- pseudo-URI not a real S3 key. The classifier still finds it via
  -- the image's /app/models directory; S3 poller takes over on the
  -- first post-56B train.
  'image-baked://intent-classifier/classifier-v1-2026-05-03.joblib',
  'pre-56b-image-baked',
  'Backfilled at slice 56B — original artifact was image-baked, not S3-resident.'
)
ON CONFLICT (model_version) DO NOTHING;

INSERT INTO bot_intent_training_membership (model_run_id, training_data_id)
  SELECT mr.id, td.id
    FROM bot_intent_model_runs mr
    JOIN bot_intent_training_data td ON td.source = 'manual_csv'
   WHERE mr.model_version = 'v1-2026-05-03'
ON CONFLICT DO NOTHING;

COMMIT;
