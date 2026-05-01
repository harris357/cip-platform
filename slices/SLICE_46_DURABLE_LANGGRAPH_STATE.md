# Slice 46 — Durable LangGraph state + LLM summarization

> **Prerequisite:** Slice 45 deployed and exercised in at least one Teams thread (`/lg on`).
> **Package:** `@cip/teams-bot`, `@cip/hr-service` (migration + endpoint for engine override persistence).
> **Verify:** `pnpm --filter @cip/teams-bot typecheck`; pod restart preserves an in-progress LangGraph thread; long conversation triggers summarization.

---

## Why

Slice 45 shipped the LangGraph runtime with three deliberate gaps:

1. **`MemorySaver` is in-process.** State dies on pod restart and isn't shared across replicas. A confirm-interrupt that fires just before a deploy loses the user's pending write call.
2. **No `summarize` node.** `state.summary` is always `''` because nothing populates it. As `messages.length` grows, every `plan` call re-sends the entire history (capped at `lg.max_recent_messages`, but messages older than that fall off entirely — no rolling memory).
3. **Per-thread engine overrides die on pod restart.** The `Map<key, Engine>` in `engine-toggle.ts` is in-process. A user who toggled `/lg on` before a deploy gets bumped back to legacy after.

This slice closes all three gaps.

## What this slice IS

1. **Postgres checkpointer** via `@langchain/langgraph-checkpoint-postgres`. Replaces `MemorySaver`. Keyed by `(thread_id)`. Survives pod restart and works across replicas (LangGraph's checkpointer interface handles concurrent access via its DB constraints).
2. **`summarize` node** — LLM call (`cip-classifier` since this is light text rewriting, not a planning task) that compresses older messages into `state.summary` once `messages.length > lg.summarize_at`. The summary stays bounded; old messages get trimmed from the array after summarization. Triggered automatically as a graph edge after `respond` whenever the threshold is exceeded.
3. **Persisted engine overrides** — new `bot_engine_overrides` table replacing the in-process Map. Same precedence as Slice 45 (per-thread → per-tenant tunable → code default).

## What this slice is NOT

- **Not a removal of legacy.** Legacy pipeline still runs on `/lg off` threads. Removing legacy is gated on 2+ weeks of toggle traffic with no LangGraph regressions.
- **Not long-term memory.** Cross-thread facts (Slice 49) and vector retrieval over past conversations (Slice 50) remain deferred.
- **Not a telemetry dashboard.** Telemetry log lines are already emitted (Slice 45); aggregation/dashboard is Slice 48.

---

## Postgres checkpointer

LangGraph's official `@langchain/langgraph-checkpoint-postgres` package handles checkpoint serialization, schema setup, and concurrency. Plug it in via the same `checkpointer` reference Slice 45 already uses:

```ts
// packages/teams-bot/src/langgraph/checkpointer.ts
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';

const POOL_URL = process.env['DATABASE_URL_HR'];
if (!POOL_URL) throw new Error('DATABASE_URL_HR required for LangGraph checkpointer');

export const checkpointer = PostgresSaver.fromConnString(POOL_URL);

// Run setup() once at process boot — creates the langgraph_checkpoints
// schema if absent. Idempotent.
let setupPromise: Promise<void> | null = null;
export async function ensureCheckpointerReady(): Promise<void> {
  if (!setupPromise) setupPromise = checkpointer.setup();
  return setupPromise;
}
```

Bot startup calls `await ensureCheckpointerReady()` before accepting traffic. Schema lives in `cip_hr` (same tech-debt note as `bot_tunables` — would consolidate to `cip_platform` if/when that DB exists).

`candidateTools` annotation gets a custom serializer to omit it from persisted state (already a hard rule in Slice 45 — re-implement the actual omission here).

---

## `summarize` node

A new graph node placed AFTER `respond` (terminal edge), conditional on threshold:

```
... → respond → shouldSummarize → summarize → END
                              └─ END
```

`shouldSummarize` reads `lg.summarize_at` (new tunable, default 12). If `state.messages.length > lg.summarize_at`, route to `summarize`; else end.

`summarize` node:
- Picks the oldest N messages where N = `lg.summarize_keep_recent` (default 6) fewer than the total — i.e., everything except the last 6.
- Calls `cip-classifier` (cheap) with a `bot.summarize` prompt (Langfuse-hosted, code fallback).
- Output is appended to `state.summary` as a fresh paragraph (or replaces if `state.summary.length > lg.summary_max_chars`).
- Replaces the older messages with a single `SystemMessage` carrying `[Earlier conversation summarized]` so the message log stays internally consistent and the planner sees a clear seam.

New tunables (seeded global defaults):
- `lg.summarize_at` = 12
- `lg.summarize_keep_recent` = 6
- `lg.summary_max_chars` = 2000

---

## Persisted engine overrides

Replaces the in-process `Map<string, Engine>` in `engine-toggle.ts`.

```sql
-- packages/hr-service/src/db/migrations/<NNN>_bot_engine_overrides.sql
CREATE TABLE IF NOT EXISTS bot_engine_overrides (
  tenant_id   UUID NOT NULL,
  thread_id   TEXT NOT NULL,
  engine      TEXT NOT NULL CHECK (engine IN ('legacy', 'langgraph')),
  set_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  set_by      TEXT,
  PRIMARY KEY (tenant_id, thread_id)
);
```

New endpoints on hr-service:
- `GET /admin/bot-engine-override?tenantId=X&threadId=Y` → `{engine: "legacy"|"langgraph"}` or 404
- `PUT /admin/bot-engine-override` body `{tenantId, threadId, engine}` → upsert

Bot reads on every turn (cached 5 min per `(tenantId, threadId)`); writes on `/lg on` / `/lg off`.

The Slice 45 in-process Map serves as a write-through cache to avoid the 5-min lag on the user's own thread. Pattern: write to DB + write to Map; read from Map first, fall back to DB on miss.

---

## Files in scope

```
packages/teams-bot/package.json                                    (+@langchain/langgraph-checkpoint-postgres)
packages/teams-bot/src/langgraph/checkpointer.ts                   (rewrite — PostgresSaver)
packages/teams-bot/src/langgraph/graph.ts                          (add summarize node + edge)
packages/teams-bot/src/langgraph/nodes/summarize.ts                NEW
packages/teams-bot/src/langgraph/engine-toggle.ts                  (DB-backed override + write-through Map)
packages/teams-bot/src/main.ts (or index.ts startup)               (call ensureCheckpointerReady)

packages/hr-service/src/db/migrations/019_bot_engine_overrides.sql NEW
packages/hr-service/src/db/queries/bot-engine-overrides.ts         NEW
packages/hr-service/src/routes/admin-bot-engine-overrides.ts       NEW
packages/hr-service/src/server.ts                                  (mount route)

packages/shared/src/clients/prompts/bot-summarize.ts               NEW (Langfuse fallback)
packages/shared/src/clients/prompts/index.ts                       (register)

packages/hr-service/src/db/migrations/<NNN>_lg_summarize_tunables.sql  NEW (seed lg.summarize_at + friends)

slices/SLICE_46_DURABLE_LANGGRAPH_STATE.md                         this file
```

---

## Hard rules

- **No silent state loss.** Every checkpoint write goes through Postgres before the bot sends its reply to Teams. If the DB write fails, log + degrade gracefully (continue without persistence) but DO NOT silently drop state.
- **Schema migration is idempotent.** `PostgresSaver.setup()` is — confirm via re-run. The override table migration uses `CREATE TABLE IF NOT EXISTS`.
- **Summarize is bounded.** `lg.summary_max_chars` enforced server-side; if the summary grows past it, the oldest paragraph is dropped.
- **No magic numbers.** Three new tunables seeded; all reads through `getTunable<T>()` with code fallbacks.
- **Single source of truth for engine override.** DB is canonical; in-process Map is a write-through cache. `/lg status` reads from DB (cached) so a status check doesn't drift from reality.

---

## Verification

**Pod restart test:** start a Teams thread with `/lg on`, ask "find Jane Smith and disable her", reply with anything when the confirm interrupt fires (should preserve), restart hr-service pod, reply "yes" — expect the saved `pendingWriteCall` to execute correctly.

**Multi-replica test:** scale teams-bot to 2 replicas, start two parallel conversations on different replicas, verify they don't see each other's state and that confirm interrupts on replica A resume correctly when traffic lands on replica B.

**Summarization test:** send 14+ messages on a single thread, observe `[turn]` log line shows `summarized=true` after the 13th, verify subsequent planner calls receive a non-empty `state.summary` and a trimmed `messages` array.

**Engine override persistence:** `/lg on`, restart pod, confirm engine is still `langgraph` for that thread (today it would revert to default).

**Cost regression:** capture token cost on a 20-turn conversation pre- and post-summarize. Expect lower per-turn cost on turns 13+ because summary replaces the older message tail.

---

## Out of scope (still deferred)

- Long-term factual memory across threads (Slice 49)
- Vector retrieval over past conversations (Slice 50)
- Telemetry dashboard (Slice 48)
- Removing the legacy pipeline (waiting on production data)

---

## Cross-slice notes

- Postgres checkpointer's schema lives in cip_hr (same as bot_tunables, routing_rules, tool_embeddings). Acknowledged tech debt — would migrate to cip_platform if/when that DB infra is wired up.
- `summarize` node uses `cip-classifier` (mistral-nemo) because it's text rewriting, not planning. If quality suffers, escalate to `cip-router-careful` per-tenant via routing_rules.
