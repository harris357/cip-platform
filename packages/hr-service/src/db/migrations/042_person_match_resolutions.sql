-- Slice 58D-A — generic person-match resolution table.
--
-- One row per MatchPersonWorkflow execution. Updated as the workflow
-- progresses (init → optional HITL offered → final). Holds the canonical
-- answer + full evidence (canonicalization output, shortlist, scoring,
-- HITL trail) for evaluation and audit.
--
-- Caller modules (cert today; future incident, training enrollment,
-- reminders) join via `caller_submission_id` — opaque string set by the
-- caller, embedded in the workflow ID per `MatchPerson-${tenantId}-${cid}`.
--
-- pg_trgm extension is required for the shortlist activity's
-- similarity() ranking against employees.full_name. The GIN index makes
-- the query indexable for tenants with thousands of employees.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS person_match_resolutions (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                UUID NOT NULL,
  workflow_id              TEXT NOT NULL,
  caller_submission_id     TEXT NOT NULL,
  initiated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at              TIMESTAMPTZ,

  -- Inputs
  source                   TEXT NOT NULL,
  candidate_text           TEXT NOT NULL,
  structured_hints         JSONB,
  context_meta             JSONB NOT NULL,
  policy                   JSONB NOT NULL,

  -- Process
  canonicalization         JSONB,
  shortlist                JSONB,
  scored_candidates        JSONB,
  hitl_offered             BOOLEAN NOT NULL DEFAULT false,
  hitl_offered_at          TIMESTAMPTZ,
  hitl_audience            TEXT,
  hitl_actor_employee_id   UUID,
  hitl_actor_role          TEXT,

  -- Outcome
  resolved_employee_id     UUID,
  resolution_source        TEXT,
  confidence               DOUBLE PRECISION,
  outcome                  TEXT NOT NULL DEFAULT 'pending'
    CHECK (outcome IN ('pending','resolved','no_resolution','cancelled')),

  evidence                 JSONB,

  CONSTRAINT pmr_resolved_when_terminal
    CHECK (
      (outcome = 'pending'  AND resolved_at IS NULL)
      OR (outcome <> 'pending' AND resolved_at IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS pmr_tenant_workflow_idx
  ON person_match_resolutions (tenant_id, workflow_id);
CREATE INDEX IF NOT EXISTS pmr_tenant_outcome_idx
  ON person_match_resolutions (tenant_id, outcome)
  WHERE outcome = 'pending';
CREATE INDEX IF NOT EXISTS pmr_tenant_initiated_idx
  ON person_match_resolutions (tenant_id, initiated_at DESC);

-- pg_trgm index for fast similarity scoring on the shortlist query
-- against employees.full_name.
CREATE INDEX IF NOT EXISTS employees_full_name_trgm_idx
  ON employees USING gin (full_name gin_trgm_ops);

-- RLS: tenant-scoped reads. Writes happen via system actor context
-- inside activities; no per-actor INSERT/UPDATE policy needed.
ALTER TABLE person_match_resolutions ENABLE ROW LEVEL SECURITY;
CREATE POLICY pmr_tenant_isolation
  ON person_match_resolutions
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
