# Slice 48 — Langfuse graph traces + structured-log telemetry

> **Prerequisite:** Slice 47b deployed (`turnId` plumbed through state + footer + `[turn]` log + `callLLM` metadata). Slice 46 NOT a hard prerequisite, but the order 46 → 48 makes sense because debugging a state-persistence bug is much easier with full graph traces.
> **Package:** `@cip/teams-bot`, `@cip/shared` (callback wrapper if shared across services).
> **Verify:** A single Teams turn produces ONE Langfuse trace whose ID == the `turnId` shown in the response footer; the trace tree shows every graph node entry/exit + every LLM call as nested spans; the structured `[turn]` log lines flow into a queryable surface.

---

## Why

Today's observability:

1. **`turnId` correlates Teams footer ↔ pod logs.** Slice 47b shipped this. Pasting `turn=<id>` lets us grep `[turn] turn=<id>` in pod logs.
2. **LLM-call metadata reaches Langfuse via LiteLLM.** Each `callLLM` invocation creates a Langfuse generation span with `purpose`, `tenantId`, prompt provenance, and (since 47b) `trace_id` set to the turnId.
3. **Per-turn `[turn]` log line carries structured fields** (engine, intent, tools attempted, step count, triage confidence, etc.).

Two gaps:

- **Langfuse traces aren't grouped by turn.** Each LLM call shows up as an isolated generation with a turnId tag, but they're not children of a parent "turn" span. There's no graph-tree view — just a flat list of LLM calls.
- **No aggregate dashboard for the structured log lines.** We log `toolsAttempted=[…]`, `clarificationFired=…`, `confirmationFired=…`, `triageConfidence=…` per turn — but these only live in pod logs. Nothing aggregates them. We can't answer "what's the wrong-tool rate this week?" without grepping.

This slice closes both gaps in one slice because they share infrastructure and concept.

## What this slice IS

1. **Langfuse callback handler** wired into the LangGraph runner so every node entry/exit becomes a span in a single per-turn trace tree. Each LLM call (already instrumented via `callLLM` metadata) nests inside the appropriate node span. Trace ID == the bot's `turnId`. Pasting a turnId from the Teams footer jumps straight to the full graph trace tree in Langfuse.
2. **Structured-log dashboard.** Aggregate `[turn]` log lines into a queryable view. Either Grafana over Loki (if we have Loki) or a Postgres `bot_turn_metrics` table the bot writes to alongside the existing log line. Dashboards show: tool-call distribution, blocked/refused-tool rate, clarification rate, confirmation rate, p50/p95 latency per stage, step-count distribution.

## What this slice is NOT

- **Not a redesign of the runner.** No new graph nodes, no behavioral changes. Pure observability layer.
- **Not LangGraph Studio integration.** That's a separate dev-tooling investment; deferred.
- **Not LangSmith.** We're already on Langfuse for LLM traces; LangSmith would duplicate.

---

## Part 1: Langfuse callback handler

LangChain provides `@langfuse/langchain` (or its successor — verify current package name) which exposes a `CallbackHandler` that hooks into LangGraph's runtime events. Wire it as a `callbacks` config option in `graph.invoke`.

```ts
// packages/teams-bot/src/langgraph/runner.ts
import { CallbackHandler } from '@langfuse/langchain';

const langfuseHandler = new CallbackHandler({
  publicKey: process.env['LANGFUSE_PUBLIC_KEY']!,
  secretKey: process.env['LANGFUSE_SECRET_KEY']!,
  baseUrl:   process.env['LANGFUSE_HOST']!,
});

const result = await graph.invoke(
  { /* state */ },
  {
    configurable: { thread_id: threadId },
    callbacks:    [langfuseHandler],
    metadata:     {
      turnId,                          // becomes the trace_id
      tenantId:    ctx.tenantId,
      employeeId:  ctx.employeeId,
      threadId,
    },
    runName: `turn-${turnId}`,         // human-friendly trace name
  },
);
```

The handler emits one span per LangGraph node + nests each `callLLM` (already instrumented) inside the right node. After this:

- A turn produces one trace tree in Langfuse (`runName = turn-<id>`).
- Spans: `ingest` → `discover` → `triage` (with the LLM call as a child) → `plan` (with LLM call) → `gateWrite` → `execute` (with MCP-tool span) → `respond`.
- Trace metadata carries `tenantId`, `employeeId`, `threadId` for filtering.

**Why this is high-leverage:** today, debugging "why did the planner pick X tool?" requires reading the `[turn]` log + cross-referencing Langfuse generations by hand. After this, you click the turnId in the footer (or paste into Langfuse search) and see everything in one tree.

---

## Part 2: Structured-log dashboard

Two implementation paths — pick based on existing infra:

### Path A: Postgres-backed metrics table

New table `bot_turn_metrics` in `cip_hr`, written to from the runner alongside the existing `[turn]` log line:

```sql
-- packages/hr-service/src/db/migrations/<NNN>_bot_turn_metrics.sql
CREATE TABLE IF NOT EXISTS bot_turn_metrics (
  turn_id              TEXT PRIMARY KEY,
  tenant_id            UUID NOT NULL,
  thread_id            TEXT NOT NULL,
  employee_id          TEXT NOT NULL,
  emitted_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  intent               TEXT NOT NULL,           -- ask | direct | tool | unknown
  tools_attempted      TEXT[],
  tools_blocked        TEXT[],                  -- write-confirm-gated
  tools_refused        TEXT[],                  -- hallucinated names + execution errors
  step_count           INT NOT NULL,
  triage_confidence    REAL,                    -- 0..1, NULL when triage failed
  clarification_fired  BOOLEAN NOT NULL,
  confirmation_fired   BOOLEAN NOT NULL,
  total_ms             INT NOT NULL,
  graph_ms             INT NOT NULL,
  fallback_hit         BOOLEAN NOT NULL         -- triage parse failure, etc.
);

CREATE INDEX IF NOT EXISTS idx_bot_turn_metrics_tenant_emitted
  ON bot_turn_metrics (tenant_id, emitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_bot_turn_metrics_emitted
  ON bot_turn_metrics (emitted_at DESC);
```

Bot's `runLangGraph` does an INSERT after sending the reply (best-effort: if the DB write fails, log it, don't fail the turn). The existing `[turn]` log line stays — it's the durable backup if the DB is unavailable.

A Grafana data source pointing at `cip_hr` reads these rows. Initial dashboards:
- **Wrong-tool rate**: count of `tools_refused` matches per tenant per day.
- **Triage health**: histogram of `triage_confidence`; rate of `fallback_hit = true`.
- **Clarification rate**: `clarification_fired = true` over total turns, broken down by tenant.
- **Confirmation rate**: `confirmation_fired = true` over write-action turns.
- **Latency**: p50/p95 of `graph_ms`, broken down by `intent`.
- **Step-count distribution**: histogram of `step_count` values.

### Path B: Loki / log aggregator

If we already have a log aggregator (Loki, Datadog, etc.), the structured `[turn]` log line is already JSON-friendly. Add a parser that recognizes the `key=value` pairs, and queries become trivial. No DB write needed.

**Recommendation: Path A.** We don't have Loki today; spinning one up just for this is heavier than a single table + Grafana. Path B becomes cheaper if we adopt centralized logging for other reasons later.

---

## Files in scope

```
packages/teams-bot/package.json                                        (+@langfuse/langchain)
packages/teams-bot/src/langgraph/runner.ts                             (CallbackHandler + Postgres write)
packages/teams-bot/src/langgraph/util/turn-metrics.ts                  NEW (writeTurnMetric helper)

packages/hr-service/src/db/migrations/<NNN>_bot_turn_metrics.sql       NEW
packages/hr-service/src/db/queries/bot-turn-metrics.ts                 NEW (helpers for dashboard queries; optional)

infra/k8s/grafana/cip-bot-dashboard.json                               NEW (dashboard definition)

slices/SLICE_48_LANGFUSE_TRACES_AND_TELEMETRY.md                       this file
```

---

## Hard rules

- **No turn fails because of telemetry.** Every metric write + Langfuse callback is best-effort. DB write fails → log it, return reply normally. Langfuse upload fails → log it, return reply normally.
- **No model-specific code in the callback handler.** Per `LLM_PROVIDER_NOTES.md`, application code writes OpenAI-style metadata; LiteLLM and Langfuse handle provider-specific naming.
- **`turnId` is the join key.** Footer → `[turn]` log → `bot_turn_metrics` row → Langfuse trace, all keyed by the same value.

---

## Verification

**Trace correlation:** send a single Teams message that triggers a `proceed` path with one tool call. After it completes:
- Footer shows `turn=<id>`.
- Pod log shows `[turn] turn=<id> ...`.
- Langfuse search by trace_id `<id>` returns one trace.
- The trace tree has spans for `ingest`, `discover`, `triage` (+ nested LLM call), `plan` (+ nested LLM call + tool call), `execute`, `respond`.
- Postgres `SELECT * FROM bot_turn_metrics WHERE turn_id = '<id>'` returns one row matching the [turn] log line fields.

**Dashboard sanity:** load the Grafana dashboard, verify each panel renders with non-empty data after 5+ turns of bot use.

**Failure mode:** stop Postgres for 30 seconds, send a Teams message, restart Postgres. The reply should arrive normally; the metrics row should be missing for that turn, and a warning log should record the DB write failure.

---

## Out of scope (still deferred)

- LangGraph Studio integration
- Long-term factual memory (Slice 49)
- Vector conversation memory (Slice 50)
- Removing the no-op `lg.default_engine` tunable

---

## Cross-slice notes

- Builds on Slice 47b's `turnId`. If 47b's turnId implementation changes, this slice's join-key assumptions need to be re-verified.
- `bot_turn_metrics` is a fact table — append-only, no updates. A future cleanup may add retention (e.g., `DELETE FROM bot_turn_metrics WHERE emitted_at < NOW() - INTERVAL '90 days'` on a cron).
- Langfuse trace IDs in our setup look like `turn=<8-char-hex>`. Langfuse does not enforce a specific format on trace IDs; we use the bot's `turnId` directly so the search box on the Langfuse UI accepts a paste from the footer.
