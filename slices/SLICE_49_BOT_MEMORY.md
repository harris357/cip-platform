# Slice 49 — Bot memory (factual + semantic) via LangGraph PostgresStore

> **Prerequisites:** Slice 45c deployed (LangGraph 1.x, openai 6.x, `@langchain/langgraph-checkpoint-postgres` installed). Slice 46 deployed (durable thread state — without persistence, "long-term memory" is a misnomer). Ideally Slice 48 also deployed so we have telemetry to evaluate whether the memory injection actually helps.
> **Package:** `@cip/teams-bot`, `@cip/hr-service` (admin endpoint + tunables).
> **Verify:** A user states a preference in thread A; bot recalls it in thread B without re-statement. A user references a topic discussed last week; bot retrieves the relevant snippet and uses it.

---

## Why this slice exists (and why it's now ONE slice, not two)

The original plan split memory into:
- **Slice 49** — keyed factual memory (`bot_memory` table, `(tenant_id, employee_id, key)`).
- **Slice 50** — semantic conversation memory (`bot_conversation_memory` pgvector table).

LangGraph 1.x's `PostgresStore` (from `@langchain/langgraph-checkpoint-postgres`) provides BOTH in one component:
- `put(namespace, key, value)` + `get(namespace, key)` — keyed lookup (was Slice 49)
- `put(..., index)` + `search(namespace, { mode: 'vector' | 'hybrid', query })` — pgvector + full-text + hybrid search (was Slice 50)
- `[tenantId, employeeId, ...]` namespacing — multi-tenant scoping
- TTL with automatic sweeping — replaces our `expires_at` design
- Filter operators (`$eq`/`$gt`/`$in`/...) for structured queries

Adopting it collapses two slices into one and removes ~600 lines of bespoke schema/query/migration code we'd otherwise own.

**Two narrow user-facing scenarios this enables:**
1. **Preferences carry over** — "always show me certs as a table" sticks across threads.
2. **Continuity across threads** — "show me the same dashboard you helped me with last week" works without restating the dashboard name.

## What this slice IS

1. **A single `PostgresStore` instance** wired into the bot at boot, configured with mistral-embed (1024-dim) and pgvector indexing on a `content` field. Two namespace conventions:
   - `[tenantId, employeeId, "facts"]` — keyed user prefs/notes (no embedding, just keyed get/put).
   - `[tenantId, employeeId, "convo"]` — embedded conversation snippets (vector + hybrid search).

2. **`loadMemory` graph node** placed BETWEEN `ingest` and `discover`. Single node hydrates BOTH:
   - Pulls all `"facts"` entries for the caller into `state.memory: Record<string, string>`.
   - On vector path enabled: embeds the latest user message and pulls top-K matching `"convo"` snippets into `state.memorySnippets: Array<{score, content, when}>`.
   - Failures degrade gracefully — empty memory + log.

3. **`extractMemory` post-respond node** that runs AFTER the user-facing reply has been emitted (off the critical path). Single LLM call to `cip-classifier` (nemo) with combined structured output:
   ```jsonc
   {
     "facts":     [{ "key": "pref.cert_format", "value": "table", "confidence": 0.85 }],
     "snippets":  [{ "content": "user is migrating site Foo's certs to AWS", "ttlMinutes": 43200 }]
   }
   ```
   Both kinds written via the same store. One LLM call replaces what would have been two in the original 49 + 50 design.

4. **`set_user_preference` MCP tool** for explicit user intent ("remember that I prefer X"). Writes a `pref.*` fact at confidence 1.0.

5. **Prompt injection** — planner's system prompt gains two new Jinja2 blocks: "What we know about you" (facts) and "Relevant from past conversations" (snippets, only when convo retrieval is enabled).

## What this slice is NOT

- **Not RLS-enforced at the DB layer.** PostgresStore manages its own connection pool with no `app.current_tenant_id` hook. Tenant isolation comes from namespace prefixing — every read and write goes through `[state.tenantId, state.employeeId, ...]`. The bot is the only writer; admin endpoints query through namespace-scoped helpers. **This is a deliberate tradeoff** vs. the bespoke approach. See "Hard rules" below.
- **Not a UI for users to manage their memory.** Future slice if asked.
- **Not cross-tenant.** Namespaces are `[tenantId, ...]` rooted.
- **Not enabled-by-default for the convo path.** `lg.memory_convo_enabled = false` until Slice 48 telemetry shows users actually want cross-thread semantic recall.

---

## Performance budget (per turn)

The biggest pre-merge concern was extractor latency on the critical path. Mitigated by deferring the extractor:

| Step | When | Cost |
|---|---|---|
| `loadMemory` keyed get | pre-triage | 2–8 ms (single namespace fetch) |
| `loadMemory` vector search | pre-triage, only if `lg.memory_convo_enabled` | 60–150 ms (1 embedding call + 1 indexed search) |
| `extractMemory` LLM call | post-respond, fire-and-forget | 250–500 ms (does NOT block user reply) |
| `extractMemory` embedding + store write | post-respond | 50–150 ms |

User-perceived latency added per turn:
- **Convo path off (default):** ~5 ms
- **Convo path on:** ~100 ms
- **Extractor:** zero (off critical path)

---

## PostgresStore configuration

```ts
// packages/teams-bot/src/langgraph/store.ts
import { PostgresStore } from '@langchain/langgraph-checkpoint-postgres/store';
import { mistralEmbeddings } from '@cip/shared/clients/embeddings';

const POOL_URL = process.env['DATABASE_URL_HR'];
if (!POOL_URL) throw new Error('DATABASE_URL_HR required for PostgresStore');

export const memoryStore = PostgresStore.fromConnString(POOL_URL, {
  schema: 'public',                  // or a dedicated `bot_memory` schema — see Hard rules
  ensureTables: true,
  ttl: {
    refreshOnRead: false,            // we set TTL deliberately on writes; no read-side renewal
    sweepIntervalMinutes: 60,
  },
  index: {
    dims: 1024,
    embed: mistralEmbeddings,        // existing client used by Slice 44 tool embeddings
    fields: ['content'],             // only the `content` field gets embedded; `facts` writes don't include it
    indexType: 'ivfflat',            // HNSW unsupported on Zen 3 due to AVX-512 SIGILL — see Slice 44
    distanceMetric: 'cosine',
    ivfflat: { lists: 100, probes: 1 },
  },
});

let setupPromise: Promise<void> | null = null;
export async function ensureStoreReady(): Promise<void> {
  if (!setupPromise) setupPromise = memoryStore.start(); // calls setup() internally
  return setupPromise;
}
```

Wired in `compile()`:
```ts
const graph = workflow.compile({
  checkpointer,                      // Slice 46
  store: memoryStore,                // this slice
});
```

Bot startup calls `await ensureStoreReady()` before accepting traffic.

---

## Namespaces

| Namespace | Contents | Embedded? | TTL default |
|---|---|---|---|
| `[tenantId, employeeId, "facts"]` | `{ value, source, confidence, updatedAt }` | No | None (durable) |
| `[tenantId, employeeId, "convo"]` | `{ content, when, turnId, kind }` | Yes (`content` field) | 30 days (`lg.memory_convo_ttl_minutes`) |

**Key conventions for `"facts"` namespace** (suggested, not enforced):

| Key prefix | Meaning | Example value |
|---|---|---|
| `pref.*` | User preference | `pref.cert_format = { value: "table", confidence: 1.0 }` |
| `team.*` | Org context | `team.department = { value: "Engineering", confidence: 0.85 }` |
| `last.*` | Last-touched entity | `last.dashboard = { value: "site-compliance-monthly", confidence: 0.7 }` |
| `note.*` | Free-form context | `note.federation_issue = { value: "...", confidence: 0.7 }` |

**Limits** (enforced server-side in `extractMemory`):
- `value` ≤ 500 chars; `content` ≤ 1500 chars
- Per-employee `"facts"` count ≤ 200 (extractor evicts oldest by `updatedAt` when over limit)
- Per-employee `"convo"` count ≤ 500; PostgresStore TTL handles this naturally

---

## `loadMemory` node

Placed BETWEEN `ingest` and `discover`:

```
ingest → loadMemory → discover → triage → ...
```

```ts
// packages/teams-bot/src/langgraph/nodes/load-memory.ts
export async function loadMemory(state, ctx) {
  const ns = [state.tenantId, state.employeeId];

  // Always-on: keyed facts
  const facts = await memoryStore.search([...ns, 'facts'], {
    mode: 'text', // no semantic — keyed lookup
    limit: getTunable<number>('lg.memory_max_facts', 30),
  });
  const factsMap: Record<string, string> = {};
  for (const item of facts) {
    if ((item.value as any).confidence >= getTunable<number>('lg.memory_confidence_threshold', 0.5)) {
      factsMap[item.key] = String((item.value as any).value);
    }
  }

  // Per-user opt-out
  if (factsMap['pref.memory_disabled'] === 'true') {
    return { memory: {}, memorySnippets: [] };
  }

  // Optional: convo retrieval
  let snippets: Array<{score:number; content:string; when:string}> = [];
  if (getTunable<boolean>('lg.memory_convo_enabled', false)) {
    const userMessage = lastUserText(state.messages);
    if (userMessage) {
      const hits = await memoryStore.search([...ns, 'convo'], {
        mode: 'hybrid',
        query: userMessage,
        limit: getTunable<number>('lg.memory_convo_topk', 5),
        similarityThreshold: getTunable<number>('lg.memory_convo_threshold', 0.65),
        vectorWeight: 0.7,
      });
      snippets = hits.map(h => ({
        score: h.score ?? 0,
        content: String((h.value as any).content),
        when: String((h.value as any).when ?? ''),
      }));
    }
  }

  return { memory: factsMap, memorySnippets: snippets };
}
```

Two new state fields on `StateAnnotation`: `memory: Record<string, string>` and `memorySnippets: Array<{score, content, when}>`. Like `candidateTools`, both are computed-not-persisted — re-derived each turn.

---

## Prompt injection

Planner system prompt (`bot.plan` Langfuse) gets two new Jinja2 blocks:

```
{% if memory and memory | length > 0 %}
## What we know about you

{% for key, value in memory.items() %}
- **{{ key }}**: {{ value }}
{% endfor %}

Use these as durable context. The user may not re-state them.
{% endif %}

{% if memorySnippets and memorySnippets | length > 0 %}
## Relevant from past conversations

{% for snip in memorySnippets %}
- ({{ snip.when }}, score={{ "%.2f" | format(snip.score) }}) {{ snip.content }}
{% endfor %}

Treat these as recall, not gospel. Confirm with the user if you're using them to drive a decision.
{% endif %}
```

Triage's `bot.triage` prompt gets only the keys (compact, to keep nemo input small):

```
{% if memory and memory | length > 0 %}
Known about this user: {{ memory.keys() | join(", ") }}.
{% endif %}
```

---

## `extractMemory` node — DEFERRED, off the critical path

Placed AFTER `respond` but as a parallel branch that does NOT block the reply:

```
... → respond → END (user sees reply)
              ↘ extractMemory → store writes → end
```

LangGraph's `interrupt` / parallel-branch mechanics let us emit the AIMessage to the user, then continue the graph in the background. The pattern is identical to a `tracingHandler.flush()` call — fire-and-forget after reply is sent.

Implementation note: in LangGraph 1.x, the cleanest way is to detach the extractor from the main graph entirely. After the user-facing graph completes, the runner kicks off a follow-up `extractMemory` invocation with the persisted thread state pulled from the checkpointer. This way the extractor's failure mode is fully isolated — a crash mid-extraction can't poison the user's reply.

```ts
// packages/teams-bot/src/langgraph/runner.ts (post-reply)
const reply = await graph.invoke(initialState, { configurable: { thread_id }, store: memoryStore });
await sendReplyToTeams(reply);

// Fire-and-forget — failures here only log, never bubble to the user
void extractMemoryAsync({ thread_id, turnId, tenantId, employeeId })
  .catch(err => logger.warn({ err, turnId }, 'extractMemory failed'));
```

`extractMemory` itself:
- Pulls the latest turn's user message + AI response + currently-known fact keys from the checkpointer.
- Calls `cip-classifier` (nemo) with a `bot.memory_extract` Langfuse prompt that returns `{ facts: [...], snippets: [...] }`.
- For each fact: upsert to `[tenantId, employeeId, "facts"]` with `key` = the fact key.
- For each snippet: write to `[tenantId, employeeId, "convo"]` with `key` = `${turnId}-${idx}`, `index: ['content']`, `ttl: ttlMinutes`.

**Hard rule on the extractor:** confidence < 0.7 facts are dropped. Snippets are gated by a separate `bot.memory_extract` heuristic — only "fact-bearing" turns produce snippets. Most chitchat turns produce zero of both.

---

## Tool-driven writes

Same MCP tool as the original Slice 49 design:

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

Handler writes to `[tenantId, employeeId, "facts"]` namespace via `memoryStore.put(...)` with `value = { value, source: 'tool', confidence: 1.0, updatedAt: now() }`.

---

## Tunables

New seeded global defaults (one migration adds them all):

| Key | Default | Purpose |
|---|---|---|
| `lg.memory_confidence_threshold` | 0.5 | Drop low-confidence facts at hydration |
| `lg.memory_max_facts` | 30 | Cap injected facts per turn |
| `lg.memory_extract_enabled` | true | Kill switch for the extractor (per-tenant) |
| `lg.memory_convo_enabled` | **false** | Convo retrieval off by default |
| `lg.memory_convo_topk` | 5 | Top-K snippets injected per turn |
| `lg.memory_convo_threshold` | 0.65 | Cosine threshold below which snippets are dropped |
| `lg.memory_convo_ttl_minutes` | 43200 | 30 days |

---

## Files in scope

```
packages/teams-bot/src/langgraph/store.ts                                       NEW
packages/teams-bot/src/langgraph/nodes/load-memory.ts                           NEW
packages/teams-bot/src/langgraph/nodes/extract-memory.ts                        NEW
packages/teams-bot/src/langgraph/state.ts                                       (+ memory + memorySnippets fields)
packages/teams-bot/src/langgraph/graph.ts                                       (+ loadMemory edge)
packages/teams-bot/src/langgraph/runner.ts                                      (post-reply extractor kickoff)
packages/teams-bot/src/index.ts                                                 (call ensureStoreReady at boot)

packages/hr-service/src/modules/employees/mcp-tools/set-user-preference.tool.ts NEW
packages/hr-service/src/modules/employees/mcp-tools/index.ts                    (register)

packages/hr-service/src/db/migrations/<NNN>_lg_memory_tunables.sql              NEW (seed 7 keys)

packages/shared/src/clients/embeddings.ts                                       NEW (mistralEmbeddings export — wraps existing cip-embed call into LangChain Embeddings interface)
packages/shared/src/clients/prompts/bot-memory-extract.ts                       NEW
packages/shared/src/clients/prompts/index.ts                                    (register)
packages/shared/src/clients/prompts/bot-plan.ts                                 (+ memory + memorySnippets injection blocks)
packages/shared/src/clients/prompts/bot-triage.ts                               (+ compact memory hint)

slices/SLICE_49_BOT_MEMORY.md                                                   this file (replaces SLICE_49 + SLICE_50)
```

PostgresStore creates its own tables on first `setup()` — no manual migration for the storage tables.

---

## Hard rules

- **No turn fails because of memory.** Hydration fails → empty maps, log it. Extractor fails → no writes, log it (already off the critical path). Tool-driven write fails → tool returns refusal, turn continues.
- **Tenant isolation via namespace, not RLS.** Every read/write MUST prepend `[state.tenantId, state.employeeId, ...]`. Document this in `load-memory.ts` and `extract-memory.ts` headers because it's a deviation from the rest of the codebase's RLS pattern. A future hardening could add a `pgcrypto`-based row-key check, but for now namespace prefixing is the contract — and the bot is the only writer.
- **`memoryStore` lives in `cip_hr` schema** for the same tech-debt reason as `bot_tunables` and the checkpointer (Slice 46) and `tool_embeddings` (Slice 44).
- **No model-specific code.** Per `LLM_PROVIDER_NOTES.md`. `bot.memory_extract` prompt uses canonical message shape (system + user-role).
- **Extractor is OFF the critical path.** No await on `extractMemoryAsync`. Failures only log.
- **Extractor never writes confidence < 0.7.**
- **Convo path is OFF by default.** Flip `lg.memory_convo_enabled = true` per-tenant after Slice 48 telemetry shows demand.
- **Per-user opt-out.** A `pref.memory_disabled = "true"` fact short-circuits the loader to empty maps before injecting anything.
- **No magic numbers.** Seven new tunables seeded; all reads through `getTunable<T>()`.

---

## Verification

**Round-trip — facts:**
1. Send "always format my certs as a table" in thread A. Wait for the reply + a few seconds for extractor.
2. Confirm the store has `[tenantId, employeeId, "facts"]/pref.cert_format = { value: "table", source: "extractor", confidence: ≥0.7 }`.
3. Open thread B. Ask "show my certs".
4. Verify response is a table.

**Round-trip — convo (only if `lg.memory_convo_enabled = true` for tenant):**
1. In thread A: have a substantive conversation about migrating site Foo's certs.
2. Confirm a `[tenantId, employeeId, "convo"]/<turnId>-<idx>` entry exists with `content` describing the migration.
3. Open thread B. Ask "what was that thing about Foo's certs?"
4. Verify the planner prompt received a "Relevant from past conversations" block with the matching snippet.

**Tool-driven test:** ask "remember that my main team is Engineering." Bot calls `set_user_preference`. Confirm the fact is written with `source: 'tool'`, `confidence: 1.0`.

**Confidence floor test:** force the extractor to produce a 0.6 confidence fact. Verify it is NOT written.

**Cap test:** seed 50 fake `facts` rows for one user. Loader injects only top 30 by `updatedAt`.

**Kill switch test:** set `lg.memory_extract_enabled = false` for a tenant. Confirm extractor doesn't run after subsequent turns. Set `lg.memory_convo_enabled = false` after enabling — confirm planner prompt no longer shows the "Relevant from past conversations" block.

**Off-the-critical-path test:** add a 5-second `setTimeout` to `extractMemoryAsync` for a single test turn. Verify the user's reply arrives in <2s anyway. Confirm the extractor still runs and writes to the store.

**Tenant isolation test:** seed facts for tenant A's employee. From a thread on tenant B (same `employeeId` if the IDs happen to collide), verify the loader returns empty — namespace prefix prevents cross-tenant reads.

---

## Out of scope (deferred)

- User-facing UI to view / edit / delete memories.
- Cross-tenant memory (intentionally scoped per-tenant).
- DB-level RLS enforcement on store tables (would require a fork of PostgresStore — namespace prefixing is the contract).
- Manual GC cron (PostgresStore TTL sweeping handles `"convo"` expiration).

---

## Cross-slice notes

- This slice replaces both the original Slice 49 (factual memory) and Slice 50 (vector conversation memory). The merge is enabled by adopting LangGraph 1.x's native `BaseStore`.
- `memoryStore` and the Slice 46 checkpointer come from the same npm package (`@langchain/langgraph-checkpoint-postgres`). Same connection string. Different schema tables — the store's tables are managed by its own `setup()`.
- `mistralEmbeddings` wraps the existing `cip-embed` LiteLLM call (used by Slice 44). Reuse, don't duplicate.
- `extractMemory` running off the critical path means the user's reply is unaffected by extractor latency or failure — this is the architectural mitigation for the original concern that "running the extractor inline adds 250–600 ms per turn."
- The decision to forgo DB-level RLS on store rows is a deliberate tradeoff for code simplicity. If audit / compliance requirements later demand RLS, the migration path is to fork PostgresStore or replace it with custom code (~600 LOC).
