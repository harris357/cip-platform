# Slice 49 — Long-term factual memory across conversation threads

> **Prerequisite:** Slice 46 deployed (durable Postgres state — without it, "long-term" is a misnomer because we already lose state across restarts). Ideally Slice 48 also deployed so we have telemetry to evaluate whether the memory injection is actually helping.
> **Package:** `@cip/teams-bot`, `@cip/hr-service` (table + admin endpoint).
> **Verify:** A user states a preference in thread A; bot recalls it in a fresh thread B without the user re-stating it.

---

## Why

Today's bot has no cross-thread memory. Each Teams thread starts fresh — no record of "Sarah prefers JSON output", "Tom is in the Engineering team", "this user previously asked about cert.approve". Every conversation re-derives context from scratch.

Two narrow user-facing scenarios this enables:

1. **Preferences carry over.** User says "always show me certs in a table format" once; the bot remembers and applies it in future threads.
2. **Continuity across threads.** "Show me the same dashboard you helped me with last week" works without re-stating the dashboard name.

This is **NOT** semantic conversation memory (Slice 50) — that's vector retrieval over past message content. This slice is keyed lookups: typed facts the bot or extractor wrote with intent.

## What this slice IS

1. **`bot_memory` table** in `cip_hr`, keyed `(tenant_id, employee_id, key)`.
2. **Hydration into LangGraph state** at turn start — `discover` (or a new `loadMemory` node before `triage`) reads the caller's facts into a new `state.memory` field.
3. **Two write paths**:
   - **Post-turn extractor** — a cheap LLM call (`cip-classifier` / nemo) that runs after `respond`, looking for facts worth memorizing. Outputs a small set of `{key, value, scope}` records the bot upserts.
   - **Tool-driven writes** — a new MCP tool `set_user_preference` (or similar) that lets the planner explicitly write a memory. Useful when the user says "remember that I prefer X."
4. **Prompt injection** — a "What we know about you" markdown block in the planner's system prompt, populated from `state.memory`. Same pattern as the Slice 45 `tool_reference` block.

## What this slice is NOT

- **Not semantic conversation memory.** Slice 50.
- **Not a UI for users to manage their memory.** Future slice if users ask for it.
- **Not cross-tenant.** Memories are scoped per `(tenant_id, employee_id)`.
- **Not a generic key-value store.** Limited to "what we know about this user" — facts, preferences, context. Not arbitrary state.

---

## Schema

```sql
-- packages/hr-service/src/db/migrations/<NNN>_bot_memory.sql
CREATE TABLE IF NOT EXISTS bot_memory (
  tenant_id    UUID NOT NULL,
  employee_id  TEXT NOT NULL,        -- AAD oid or KC sub
  key          TEXT NOT NULL,
  value        TEXT NOT NULL,        -- short fact, ≤ 500 chars
  source       TEXT NOT NULL,        -- 'extractor' | 'tool' | 'admin'
  confidence   REAL NOT NULL DEFAULT 1.0,  -- 0..1, lowered if extractor was unsure
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at   TIMESTAMPTZ,          -- nullable; set by extractor for time-bound facts
  PRIMARY KEY (tenant_id, employee_id, key)
);

-- RLS pattern matches employees / certifications: the user can only
-- read/write their own row.
ALTER TABLE bot_memory ENABLE ROW LEVEL SECURITY;
CREATE POLICY bot_memory_self ON bot_memory
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID);
```

**Key conventions** (suggested, not enforced):

| Key prefix | Meaning | Example value |
|---|---|---|
| `pref.*` | User preference | `pref.cert_format = "table"` |
| `team.*` | Org context | `team.department = "Engineering"` |
| `last.*` | Last-touched entity | `last.dashboard = "site-compliance-monthly"` |
| `note.*` | Free-form context | `note.aad_federation_issue = "Resolved 2026-04-15 via OID re-link"` |

Operators can extend conventions per tenant.

**Limits** (enforce server-side):
- `value` ≤ 500 chars (truncate with warning if extractor produces longer)
- Per-employee row count ≤ 200 (extractor evicts oldest by `updated_at` when over limit)
- `expires_at` defaults NULL; extractor can set it for facts like `last.*`

---

## Hydration

A new `loadMemory` node placed BETWEEN `ingest` and `discover`:

```
ingest → loadMemory → discover → triage → ...
```

`loadMemory`:
- Reads `bot_memory` rows for `(state.tenantId, state.employeeId)` where `expires_at IS NULL OR expires_at > NOW()`.
- Filters by `confidence >= lg.memory_confidence_threshold` (new tunable, default 0.5).
- Caps at top N rows by `updated_at DESC` where N = `lg.memory_max_facts` (new tunable, default 30).
- Sets `state.memory` to a `Record<string, string>` map.

A new state field `memory: Record<string, string>` is added to `StateAnnotation`. Like `candidateTools`, it's computed-not-persisted (re-derived each turn).

---

## Prompt injection

Planner system prompt (`bot.plan` Langfuse) gets a new Jinja2 block:

```
{% if memory and memory | length > 0 %}
## What we know about you

{% for key, value in memory.items() %}
- **{{ key }}**: {{ value }}
{% endfor %}

Use these as durable context. The user may not re-state them.
{% endif %}
```

Triage's `bot.triage` prompt also gets a compact version (just keys, not values, to keep the cheap nemo's input small):

```
{% if memory and memory | length > 0 %}
Known about this user: {{ memory.keys() | join(", ") }}.
{% endif %}
```

---

## Post-turn extractor

A new `extractMemory` node placed AFTER `respond` (parallel-ish with Slice 46's `summarize`):

```
... → respond → extractMemory → END
              ↘ summarize (Slice 46)
```

`extractMemory` runs only when the turn produced a tool call OR a substantive AIMessage (skip chitchat). Calls `cip-classifier` (nemo) with a `bot.memory_extract` Langfuse prompt that:
- Takes the latest user message + AI response + currently-known memory keys.
- Outputs strict JSON: `{ writes: [{ key, value, confidence, expires_at? }] }`.
- Emits zero or more `writes` per turn — most turns produce zero.

The bot upserts each write into `bot_memory`. Conflicts (same key) overwrite if new confidence ≥ existing confidence.

**Hard rule on the extractor:** it writes ONLY facts grounded in the just-completed turn. No speculation, no inference beyond what the user said or the bot did. Confidence < 0.7 entries are skipped (not written) to keep the table clean.

---

## Tool-driven writes

A new MCP tool `set_user_preference`:

```ts
{
  name: 'set_user_preference',
  description: 'Save a durable preference for the calling user.',
  whenToUse: ['User explicitly says "remember X" / "always do Y" / "default to Z"'],
  whenNotToUse: ['Inferring preferences (the extractor handles that)', 'Setting preferences for ANOTHER user'],
  sideEffectLevel: 'write',
  requiredPermission: null,    // self-write only
  inputSchema: {
    key:   z.string().regex(/^pref\.[a-z_]+$/),
    value: z.string().max(500),
  },
  outputSchema: { type: 'object', properties: { saved: z.boolean() } },
}
```

The planner calls this when the user explicitly asks. Server-side handler writes to `bot_memory` with `source = 'tool'` and `confidence = 1.0`.

---

## Tunables

New seeded global defaults:
- `lg.memory_confidence_threshold` = 0.5 (drop low-confidence facts at hydration)
- `lg.memory_max_facts` = 30 (cap injected facts per turn)
- `lg.memory_extract_enabled` = true (kill switch for the extractor)

---

## Files in scope

```
packages/hr-service/src/db/migrations/<NNN>_bot_memory.sql                     NEW
packages/hr-service/src/db/migrations/<NNN+1>_lg_memory_tunables.sql           NEW (seed 3 keys)
packages/hr-service/src/db/queries/bot-memory.ts                               NEW
packages/hr-service/src/modules/employees/mcp-tools/set-user-preference.tool.ts  NEW
packages/hr-service/src/modules/employees/mcp-tools/index.ts                   (register)

packages/teams-bot/src/langgraph/state.ts                                      (+ memory field)
packages/teams-bot/src/langgraph/graph.ts                                      (+ loadMemory + extractMemory nodes/edges)
packages/teams-bot/src/langgraph/nodes/load-memory.ts                          NEW
packages/teams-bot/src/langgraph/nodes/extract-memory.ts                       NEW
packages/teams-bot/src/langgraph/util/memory-fetcher.ts                        NEW (HTTP call to admin endpoint or direct DB)

packages/hr-service/src/routes/admin-bot-memory.ts                             NEW (per-user GET + bulk UPSERT for the bot)

packages/shared/src/clients/prompts/bot-memory-extract.ts                      NEW
packages/shared/src/clients/prompts/index.ts                                   (register)
packages/shared/src/clients/prompts/bot-plan.ts                                (+ memory injection block)
packages/shared/src/clients/prompts/bot-triage.ts                              (+ compact memory hint)

slices/SLICE_49_LONG_TERM_FACTUAL_MEMORY.md                                    this file
```

---

## Hard rules

- **No turn fails because of memory.** Hydration fails → empty `state.memory`, log it. Extractor fails → no writes that turn, log it. Tool-driven write fails → tool returns refusal, turn continues.
- **Per-user RLS.** `bot_memory` rows are scoped via `app.current_tenant_id` like other employee data. Bot's hr-service queries set the tenant context first.
- **No model-specific code.** Per `LLM_PROVIDER_NOTES.md`. Extractor prompt uses canonical message shape (system + user-role messages).
- **No magic numbers.** Three new tunables seeded.
- **Extractor never writes confidence < 0.7.** Quality over recall.
- **Memory is NOT semantic.** Keyed lookup only. Slice 50 adds the vector path.
- **Memory injection is OPT-OUT, not opt-in, but with kill switches.** `lg.memory_extract_enabled = false` per-tenant disables the extractor. Per-user opt-out via a `pref.memory_disabled = "true"` row that the loader checks before injecting anything.

---

## Verification

**Round-trip test:**
1. Send "always format my certs as a table" in thread A. Wait for the turn to complete.
2. Confirm `bot_memory` has a row with `key = pref.cert_format`, `value = "table"`, `source = 'extractor'`, `confidence ≥ 0.7`.
3. Open thread B (different conversation). Ask "show my certs".
4. Verify the response is a table format (planner saw `pref.cert_format = "table"` in `state.memory`).

**Tool-driven test:** ask "remember that my main team is Engineering." Bot calls `set_user_preference` (or extractor catches it). Memory persists.

**Confidence floor test:** make the extractor produce a low-confidence write (e.g., from an ambiguous message). Verify the row is NOT created.

**Cap test:** seed 50 fake rows for one user. Loader injects only 30. Verify the 30 are the most-recent.

**Kill switch test:** set `lg.memory_extract_enabled = false` for the tenant. Confirm extractor doesn't run after subsequent turns.

---

## Out of scope (deferred)

- Vector retrieval over past conversations (Slice 50).
- User-facing UI to view / edit / delete memories.
- Cross-tenant memory (intentionally scoped per-tenant).
- Memory expiry GC (the loader's `expires_at > NOW()` filter is enough; cron-driven hard-delete is a future cleanup).

---

## Cross-slice notes

- `bot_memory` lives in `cip_hr` for the same tech-debt reason as `bot_tunables` and `tool_embeddings`.
- Slice 50 will add a separate `bot_conversation_memory` table for vector retrieval; the two tables are distinct (keyed lookup vs semantic search) and shouldn't be merged.
- The post-turn `extractMemory` node and Slice 46's `summarize` node both run after `respond`. They can run in parallel — neither depends on the other.
