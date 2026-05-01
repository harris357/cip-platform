-- Slice 48: bot_turn_metrics — append-only fact table for per-turn
-- aggregate metrics. The runner INSERTs one row after every turn,
-- alongside the existing [turn] log line. Grafana queries this for
-- dashboards (wrong-tool rate, clarification rate, p50/p95 latency,
-- etc.).
--
-- DB write is best-effort — if it fails the turn still completes;
-- the [turn] log line remains the durable backup.
--
-- Tech-debt note: lives in cip_hr alongside bot_tunables and
-- routing_rules for the same reason — no cip_platform DB exists yet.

CREATE TABLE IF NOT EXISTS bot_turn_metrics (
  turn_id              TEXT PRIMARY KEY,
  tenant_id            UUID NOT NULL,
  thread_id            TEXT NOT NULL,
  employee_id          TEXT NOT NULL,
  emitted_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  intent               TEXT NOT NULL,            -- ask | direct | tool | unknown
  tools_attempted      TEXT[] NOT NULL DEFAULT '{}',
  tools_refused        TEXT[] NOT NULL DEFAULT '{}',
  step_count           INT NOT NULL,
  triage_confidence    REAL,                     -- 0..1, NULL when triage failed
  clarification_fired  BOOLEAN NOT NULL,
  confirmation_fired   BOOLEAN NOT NULL,
  resumed              BOOLEAN NOT NULL,         -- true if turn was an interrupt resume (Slice 46b)
  total_ms             INT NOT NULL,
  graph_ms             INT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bot_turn_metrics_tenant_emitted
  ON bot_turn_metrics (tenant_id, emitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_bot_turn_metrics_emitted
  ON bot_turn_metrics (emitted_at DESC);
