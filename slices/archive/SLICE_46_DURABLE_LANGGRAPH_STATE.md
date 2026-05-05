# Slice 46 — Durable LangGraph state + LLM summarization

> **Prerequisite:** Slice 47b deployed (LangGraph is the only runtime; `/lg` toggle removed). Slice 45c deployed (LangChain/LangGraph 1.x + `@langchain/langgraph-checkpoint-postgres` installed).
> **Package:** `@cip/teams-bot`, `@cip/hr-service` (migrations + tunables).
> **Verify:** `pnpm --filter @cip/teams-bot typecheck`; pod restart preserves an in-progress LangGraph thread (especially confirm-interrupted ones); long conversation triggers summarization.

---

## Why

Slice 45 shipped the LangGraph runtime with two deliberate gaps:

1. **`MemorySaver` is in-process.** State dies on pod restart and isn't shared across replicas. A confirm-interrupt that fires just before a deploy loses the user's pending write call.
2. **No `summarize` node.** `state.summary` is always `''` because nothing populates it. As `messages.length` grows, every `plan` call re-sends the entire history (capped at `lg.max_recent_messages`, but messages older than that fall off entirely — no rolling memory).

This slice closes both gaps.

> **Revision notes:**
> - **2026-05-01a:** the previous draft included a "persisted engine overrides" component for the per-thread `/lg` toggle. **Slice 47b removed the toggle entirely** — LangGraph is the only runtime. That component is dropped. The `engine-toggle.ts` file no longer exists and `lg.default_engine` is a no-op tunable awaiting removal.
> - **2026-05-01b:** Slice 45c (LangChain/LangGraph 1.x + openai 6.x upgrade) was inserted as a prerequisite. The `@langchain/langgraph-checkpoint-postgres` package this slice depends on is now installed by 45c. Same package is reused in the merged Slice 49 for `PostgresStore`.

## What this slice IS

1. **Postgres checkpointer** via `@langchain/langgraph-checkpoint-postgres`. Replaces `MemorySaver`. Keyed by `(thread_id)`. Survives pod restart and works across replicas (LangGraph's checkpointer interface handles concurrent access via its DB constraints).
2. **`summarize` node** — LLM call (`cip-classifier`, the cheap nemo, since this is text rewriting not planning) that compresses older messages into `state.summary` once `messages.length > lg.summarize_at`. The summary stays bounded; old messages get trimmed from the array after summarization. Triggered automatically as a graph edge after `respond` whenever the threshold is exceeded.

## What this slice is NOT

- **Not long-term memory.** Cross-thread facts (Slice 49) and vector retrieval over past conversations (Slice 50) remain deferred.
- **Not a telemetry dashboard.** Telemetry log lines are already emitted (Slice 47b); aggregation/dashboard + Langfuse callback integration are Slice 48.
- **Not deletion of the no-op `lg.default_engine` tunable.** Documented as tech-debt; safe to drop in a later cleanup migration.

---

## Postgres checkpointer

LangGraph's official `@langchain/langgraph-checkpoint-postgres` package handles checkpoint serialization, schema setup, and concurrency. Plug it in via the same `checkpointer` reference Slice 45 uses:

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
                              └─ END (skip)
```

`shouldSummarize` reads `lg.summarize_at` (new tunable, default 12). If `state.messages.length > lg.summarize_at`, route to `summarize`; else end.

`summarize` node:
- Picks the oldest N messages where N = `state.messages.length - lg.summarize_keep_recent` (default keep recent: 6) — i.e., everything except the last 6.
- Calls `cip-classifier` (nemo) with a `bot.summarize` prompt (Langfuse-hosted, code fallback).
- Output is appended to `state.summary` as a fresh paragraph (or replaces if `state.summary.length > lg.summary_max_chars`).
- Replaces the older messages with a single `SystemMessage` carrying `[Earlier conversation summarized]` so the message log stays internally consistent and the planner sees a clear seam.

**Canonical message-shape rule** (per `slices/LLM_PROVIDER_NOTES.md`): the summarize call sends a system prompt + a user-role message containing the conversation excerpt to summarize. Single-message system-only requests are forbidden by convention.

New tunables (seeded global defaults):
- `lg.summarize_at` = 12
- `lg.summarize_keep_recent` = 6
- `lg.summary_max_chars` = 2000

---

## Files in scope

```
packages/teams-bot/package.json                                    (+@langchain/langgraph-checkpoint-postgres)
packages/teams-bot/src/langgraph/checkpointer.ts                   (rewrite — PostgresSaver)
packages/teams-bot/src/langgraph/graph.ts                          (add summarize node + edge)
packages/teams-bot/src/langgraph/nodes/summarize.ts                NEW
packages/teams-bot/src/index.ts                                    (call ensureCheckpointerReady at boot)

packages/shared/src/clients/prompts/bot-summarize.ts               NEW (Langfuse fallback)
packages/shared/src/clients/prompts/index.ts                       (register)

packages/hr-service/src/db/migrations/<NNN>_lg_summarize_tunables.sql  NEW (seed lg.summarize_at + friends)

slices/SLICE_46_DURABLE_LANGGRAPH_STATE.md                         this file
```

---

## Hard rules

- **No silent state loss.** Every checkpoint write goes through Postgres before the bot sends its reply to Teams. If the DB write fails, log + degrade gracefully (continue without persistence) but DO NOT silently drop state.
- **Schema migration is idempotent.** `PostgresSaver.setup()` is — confirm via re-run.
- **Summarize is bounded.** `lg.summary_max_chars` enforced server-side; if the summary grows past it, the oldest paragraph is dropped.
- **No magic numbers.** Three new tunables seeded; all reads through `getTunable<T>()` with code fallbacks (per Slice 45's hard rule).
- **No model-specific code.** Application code writes OpenAI-style messages; LiteLLM handles provider-specific behavior. (Per `LLM_PROVIDER_NOTES.md`.)
- **Summarize call always includes a user message.** Never single-system-message.

---

## Verification

**Pod restart test:** start a Teams thread, ask "find Jane Smith and disable her", reply with anything when the confirm interrupt fires (should preserve), restart the bot pod, reply "yes" — expect the saved `pendingWriteCall` to execute correctly.

**Multi-replica test:** scale teams-bot to 2 replicas, start two parallel conversations on different replicas, verify they don't see each other's state and that confirm interrupts on replica A resume correctly when traffic lands on replica B.

**Summarization test:** send 14+ messages on a single thread, observe `[turn]` log line shows `summaryMs > 0` after the threshold is exceeded, verify subsequent planner calls receive a non-empty `state.summary` and a trimmed `messages` array.

**Cost regression:** capture token cost on a 20-turn conversation pre- and post-summarize. Expect lower per-turn cost on turns 13+ because summary replaces the older message tail.

---

## Out of scope (still deferred)

- Long-term factual memory across threads (Slice 49)
- Vector retrieval over past conversations (Slice 50)
- Telemetry dashboard + Langfuse callback (Slice 48)
- Removing the no-op `lg.default_engine` tunable (housekeeping, can ride along here or in a later migration)

---

## Cross-slice notes

- Postgres checkpointer's schema lives in `cip_hr` (same as `bot_tunables`, `routing_rules`, `tool_embeddings`). Acknowledged tech debt — would migrate to `cip_platform` if/when that DB infra is wired up.
- `summarize` node uses `cip-classifier` (nemo) because it's text rewriting, not planning. If quality suffers, escalate to `cip-router-careful` per-tenant via `routing_rules`.
- `bot.summarize` is a new Langfuse prompt; per `LLM_PROVIDER_NOTES.md` it must include the user-role message containing the message excerpt to summarize. Triage and meta_compose followed this canonical shape after Slice 47b.
