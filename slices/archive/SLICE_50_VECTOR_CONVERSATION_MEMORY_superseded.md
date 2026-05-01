# Slice 50 — Vector retrieval over past conversations

> **Prerequisite:** Slice 46 (durable state) and Slice 49 (long-term factual memory) deployed. Slice 49's extractor and prompt-injection conventions are reused here for the vector path. Slice 48 (telemetry) recommended so we can measure whether the retrieved memory actually helps planner accuracy.
> **Package:** `@cip/teams-bot`, `@cip/hr-service`.
> **Verify:** A multi-turn conversation in thread A about a specific topic creates retrievable memory rows; a future thread B's query semantically matching that topic surfaces those rows in the planner's context.

---

## Why

Slice 49 handles **keyed** memory ("user prefers JSON" — exact-match lookup). This slice handles **semantic** memory:

- "What did we figure out about the AAD federation issue last month?"
- "Last time we looked at the dashboard for site B, what was the issue?"
- "I think we discussed something similar last week — show me."

These queries can't be answered with `bot_memory` lookups because the user doesn't know the right key. They need vector retrieval over distilled-conversation summaries.

This is the heaviest of the three memory slices (49, 50, and the in-thread `summarize` from 46). Should ship LAST and only after we have telemetry data showing users actually ask cross-thread semantic recall questions.

## What this slice IS

1. **`bot_conversation_memory` table** in `cip_hr` with pgvector embeddings (1024-dim, mistral-embed compatible).
2. **Post-turn extractor extension.** Slice 49's extractor produces keyed facts; we add a parallel pipeline that produces *narrative* summaries — short paragraphs describing what the conversation accomplished. These get embedded and stored.
3. **Per-turn semantic retrieval.** Add a step in the LangGraph `discover` node (or a parallel `loadConversationMemory` node) that embeds the user's latest message and pgvector-searches `bot_conversation_memory` for top-K matches scoped to the calling user. Top-K results are injected into the planner's prompt under a "Relevant from past conversations" block.
4. **Kill switch + budget.** Per-tenant tunable `lg.conversation_memory_enabled` (default false until proven valuable); per-user `pref.conversation_memory_disabled = "true"` opt-out.

## What this slice is NOT

- **Not full conversation transcripts.** We extract distilled summaries — not raw message logs. Privacy + token cost.
- **Not cross-user.** Each user retrieves only their own memories. (Tenant-scoped isolation enforced via RLS, same as `bot_memory`.)
- **Not real-time across conversations.** Eventually consistent — the extractor runs after the turn that produced the relevant content.
- **Not a replacement for Slice 49.** Keyed facts (preferences, IDs, etc.) live in `bot_memory`; narrative recall lives here. Both injected into the planner prompt under different headings.

---

## Schema

```sql
-- packages/hr-service/src/db/migrations/<NNN>_bot_conversation_memory.sql
-- pgvector extension already enabled on cip_hr (Slice 44).
-- HNSW index NOT used — Zen 3 nodes don't support AVX-512 (Slice 44 ran into this).
-- Sequential scan over per-user rows is sub-ms at our scale.

CREATE TABLE IF NOT EXISTS bot_conversation_memory (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL,
  employee_id  TEXT NOT NULL,
  thread_id    TEXT NOT NULL,            -- source thread (for trace-back)
  turn_id      TEXT,                     -- specific turn that produced this memory (for trace-back)
  topic        TEXT NOT NULL,            -- short label, ≤ 80 chars
  summary      TEXT NOT NULL,            -- narrative paragraph, ≤ 500 chars
  embedding    vector(1024) NOT NULL,    -- mistral-embed via cip-embed alias
  metadata     JSONB,                    -- {tools_used: [...], entities: {...}}
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at   TIMESTAMPTZ               -- nullable; for time-bound memories
);

CREATE INDEX IF NOT EXISTS idx_bot_conv_memory_user
  ON bot_conversation_memory (tenant_id, employee_id, created_at DESC);

ALTER TABLE bot_conversation_memory ENABLE ROW LEVEL SECURITY;
CREATE POLICY bot_conv_memory_self ON bot_conversation_memory
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
```

**Why no HNSW index:** Slice 44 demonstrated that pgvector's HNSW index on Zen 3 nodes triggers SIGILL because it uses AVX-512 instructions. Sequential cosine scan over per-user rows (typically < 200 per user) is sub-millisecond. If a single user accumulates thousands of rows, we revisit (eviction policy first, infrastructure second).

**Eviction:** soft cap at `lg.conversation_memory_max_per_user` rows per `(tenant_id, employee_id)` (default 200). On insert, if over cap, delete the oldest row (`ORDER BY created_at ASC LIMIT 1`).

---

## Post-turn extractor extension

Slice 49's `extractMemory` node already runs after `respond`. We extend it (or add a parallel `extractConversationMemory` node) to produce a narrative summary of the turn:

```
... → respond ─┬─→ summarize           (Slice 46: in-thread compaction)
               ├─→ extractMemory       (Slice 49: keyed facts)
               └─→ extractConvMemory   (Slice 50: this slice — narrative + embedding)
```

`extractConvMemory`:
- Skip if turn was chitchat or zero-tool.
- Skip if `lg.conversation_memory_enabled = false` for tenant OR user has `pref.conversation_memory_disabled = "true"`.
- Call `cip-classifier` (nemo) with `bot.conversation_memory_extract` prompt.
  - Inputs: latest user message + AI response + `lastToolFacts` + topic of currentGoal.
  - Output: strict JSON `{ topic: string, summary: string }` OR null (skip).
- Embed the `topic + summary` via `cip-embed` (mistral-embed, 1024-dim).
- INSERT row into `bot_conversation_memory` with thread + turn linkage.
- Best-effort: failure logs but doesn't break the turn.

The extractor tags low-quality turns as "skip" and emits no row. Most chitchat-y turns produce no row.

---

## Per-turn retrieval

Two integration points to consider:

**Option A: extend `discover` node.** After permission filter + tool retrieval, also retrieve top-K conversation memories.

**Option B: parallel `loadConversationMemory` node** between `loadMemory` (Slice 49) and `triage`.

Recommendation: **Option B**. Cleaner separation of concerns; `discover` stays focused on tools.

```
ingest → loadMemory (49) → loadConversationMemory (50) → discover → triage → ...
```

`loadConversationMemory`:
- Embed `state.latestUserText` via `cip-embed` (cached LRU per Slice 44 pattern).
- Cosine-search `bot_conversation_memory` scoped to `(tenantId, employeeId)`.
- Filter `expires_at > NOW() OR expires_at IS NULL`.
- Return top-K rows where K = `lg.conversation_memory_top_k` (default 3).
- Set `state.conversationMemory: Array<{ topic, summary, age_days }>`.

State annotation gets a new field `conversationMemory: Array<{...}>` (computed-not-persisted, like `candidateTools`).

---

## Prompt injection

`bot.plan` Langfuse prompt gets a new block (sibling of the Slice 49 `What we know about you` block):

```
{% if conversationMemory and conversationMemory | length > 0 %}
## Relevant from past conversations

{% for m in conversationMemory %}
- **{{ m.topic }}** ({{ m.age_days }}d ago): {{ m.summary }}
{% endfor %}

These are summaries of earlier threads with this user. Use them as context;
the user may not re-explain.
{% endif %}
```

Triage's `bot.triage` prompt gets a one-liner version (just topics, no summaries — keep nemo's input small):

```
{% if conversationMemory and conversationMemory | length > 0 %}
Possibly relevant past topics: {{ conversationMemory | map(attribute='topic') | join("; ") }}.
{% endif %}
```

---

## Tunables

New seeded global defaults (all read via `getTunable<T>`):
- `lg.conversation_memory_enabled` = false (kill switch — flip to true per-tenant once we're satisfied)
- `lg.conversation_memory_top_k` = 3
- `lg.conversation_memory_max_per_user` = 200
- `lg.conversation_memory_min_age_seconds` = 60 (don't retrieve memories created in the last minute — usually noise from the same conversation that's still fresh in `state.messages`)

---

## Files in scope

```
packages/hr-service/src/db/migrations/<NNN>_bot_conversation_memory.sql           NEW
packages/hr-service/src/db/migrations/<NNN+1>_lg_conversation_memory_tunables.sql NEW
packages/hr-service/src/db/queries/bot-conversation-memory.ts                     NEW
packages/hr-service/src/routes/admin-bot-conversation-memory.ts                   NEW (search + insert endpoints)

packages/teams-bot/src/langgraph/state.ts                                         (+ conversationMemory field)
packages/teams-bot/src/langgraph/graph.ts                                         (+ loadConversationMemory + extractConvMemory nodes)
packages/teams-bot/src/langgraph/nodes/load-conversation-memory.ts                NEW
packages/teams-bot/src/langgraph/nodes/extract-conversation-memory.ts             NEW
packages/teams-bot/src/langgraph/util/conversation-memory-client.ts               NEW

packages/shared/src/clients/prompts/bot-conversation-memory-extract.ts            NEW
packages/shared/src/clients/prompts/index.ts                                      (register)
packages/shared/src/clients/prompts/bot-plan.ts                                   (+ "Relevant from past conversations" block)
packages/shared/src/clients/prompts/bot-triage.ts                                 (+ compact past-topics hint)

slices/SLICE_50_VECTOR_CONVERSATION_MEMORY.md                                     this file
```

---

## Hard rules

- **No turn fails because of conversation memory.** Same fail-open principle as Slice 49.
- **Per-user, per-tenant scope.** RLS-enforced via `app.current_tenant_id`. The retrieval query filters by `(tenant_id, employee_id)` explicitly.
- **No HNSW index.** Sequential scan only (Slice 44 lesson). Sub-ms at < 200 rows/user.
- **No magic numbers.** Four new tunables seeded.
- **Off by default.** `lg.conversation_memory_enabled = false` until production data justifies enabling.
- **No raw transcripts stored.** Only the LLM-distilled `summary` ≤ 500 chars. Privacy + token cost.
- **No model-specific code.** Per `LLM_PROVIDER_NOTES.md`. Extractor uses canonical message shape (system + user role).
- **Embedding via `cip-embed` (mistral-embed, 1024-dim).** Schema dimension matches.

---

## Verification

**End-to-end recall:**
1. Enable `lg.conversation_memory_enabled = true` for the dev tenant.
2. In thread A, have a substantive turn about "the AAD federation OID re-link issue for Jane Smith".
3. After the turn completes, verify `bot_conversation_memory` has one row matching that topic.
4. Open thread B (different conversation). Ask "remind me about that AAD issue we worked on."
5. Verify the planner's reply references the prior thread's resolution.
6. Verify the prompt sent to `cip-router-careful` (visible in Langfuse trace, Slice 48) includes the "Relevant from past conversations" block with the right entry.

**Off-by-default test:** with `lg.conversation_memory_enabled = false`, run the same flow. Verify no rows are written and no retrieval block appears in the planner prompt.

**Cap test:** seed 250 rows for one user. Insert one more. Verify count stays at 200 (oldest evicted).

**Min-age test:** create a memory, then immediately query for it from the same thread. Verify it doesn't surface (filtered by `lg.conversation_memory_min_age_seconds`).

---

## Out of scope (deferred)

- User-facing UI to browse / delete past conversation memories.
- Cross-thread memories visible to admins (we'd need an admin tool that respects user privacy).
- Embedding model alignment with Slice 44's `tool_embeddings` table — they share `cip-embed` but live in separate tables and have different lifetimes.
- Smart merging of similar memories (today: insert + LRU evict; tomorrow: detect duplicates and consolidate).

---

## Cross-slice notes

- Reuses `cip-embed` alias (mistral-embed) and the LRU embed cache from Slice 44.
- `bot_conversation_memory` is **distinct** from `agent_memory_vectors` (Slice 003 — 1536-dim, OpenAI ada era, used by an unrelated agent). Don't merge them; different consumers, different lifetimes, different embedding dimensions.
- Tunables follow the `lg.*` prefix convention from Slice 45.
- The runtime architecture diagram (`slices/LANGGRAPH_ARCHITECTURE.md`) needs to be regenerated after this slice ships — two new nodes, edges, and a new state field.
- This slice's narrative-summary extractor is independent of Slice 49's keyed-fact extractor. Both run after `respond`. They can produce overlapping output (the same turn might yield both a `pref.X` row in `bot_memory` AND a narrative summary in `bot_conversation_memory`). That's acceptable — different retrieval paths use them differently.
