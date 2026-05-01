# Slice 44 — Tool catalog embeddings (vector retrieval pre-filter)

> **Prerequisite:** Slice 43 complete. Tool descriptions follow the scope/audience/output shape; `requiredPermission` annotations are present on every tool; the bot's intent pipeline is `chitchat | meta | proceed` with a single `route` alias.
> **Package:** `@cip/hr-service` (indexer + new table), `@cip/teams-bot` (retrieval step in `discoverTools`)
> **Verify:** `pnpm --filter @cip/hr-service typecheck && pnpm --filter @cip/teams-bot typecheck`, plus a smoke test that proves top-K retrieval returns the correct tool for a known query (see Verification).

---

## Why This Slice Exists

After Slice 43 the bot's router LLM (`mistral-small-latest`) sees every permitted tool every turn. At ~30 tools that's fine — the model picks correctly, input is ~5K tokens. The model's accuracy and the per-turn cost both degrade as the catalog grows; production systems handle this with **retrieval pre-filtering**: embed each tool, embed the user message, pass only the top-K most similar tools to the function-calling model.

We don't need it yet (~30 tools is well below the threshold), but two things make it worth building now:

1. **The infra is already in place.** pgvector is installed on `cip_hr` ([scripts/bootstrap.sh:34-37](../scripts/bootstrap.sh#L34-L37)) and there's a proven HNSW indexing pattern in `agent_memory_vectors` ([003_ai_memory.sql:58-77](../packages/hr-service/src/db/migrations/003_ai_memory.sql#L58-L77)). Adding tool retrieval is a copy-paste of that pattern, not new infrastructure.
2. **The tool catalog is growing.** Slice 42A/42C added 8 admin tools; future slices will keep adding (settings, tenant management, document workflows). Pre-building retrieval means the bot scales without a rewrite when we cross the ~80-tool threshold where wrong-sibling picks start.

This slice does NOT replace Slice 43's description sweep — both work together. Good descriptions make embeddings semantically meaningful; bad descriptions produce noisy vectors.

---

## What 44 DOES

- **Adds `tool_embeddings` table** with `vector(1024)` (mistral-embed dim) and HNSW cosine index. RLS-free — embeddings are global to hr-service, not tenant-scoped.
- **Adds an indexer** that runs on hr-service startup, walks every registered MCP tool, computes `description_hash = sha256(name + description + JSON.stringify(paramSchema))`, and re-embeds via `mistral-embed` only when the hash differs from the stored row. Steady state: zero embedding API calls per pod restart (just N hash comparisons + 1 batched SELECT). Idempotent across pod restarts and multi-replica deploys (DB unique constraint on `(service, tool_name)`).
- **Orphan cleanup.** After the upsert pass, the indexer DELETEs any `tool_embeddings` row whose `(service, tool_name)` is *not* in the current registered set — handles tools removed from the codebase between deploys. Runs in the same transaction as the upserts so a partial registry never wipes embeddings.
- **Multi-replica race safety.** Multiple hr-service pods may start simultaneously and both try to embed an unhashed tool. The unique constraint on `(service, tool_name)` makes the upsert race-safe (one wins, the other gets `ON CONFLICT` and skips). Both still pay the embedding API call before the conflict — accepted; happens only on first-deploy and is bounded by replica count.
- **Adds retrieval to `discoverTools`** — between the existing permission filter and the return:
  1. Embed `ctx.message` with `mistral-embed`.
  2. Cosine query against `tool_embeddings`, top K (default 15) tool names.
  3. Intersect with the permission-filtered set.
  4. If the intersection is empty (no permitted tool in top K — rare), fall back to the full permission-filtered list.
  5. Return.
- **Adds a `cip-embed` LiteLLM alias** pointing at `mistral-embed`. Operators can override per-tenant via `routing_rules` (consistent with the existing model-routing pattern).
- **Caches embeddings** of recent user messages in-memory (LRU, 256 entries, 60s TTL) so retries and multi-turn flows don't re-embed identical text.

## What 44 does NOT do

- Doesn't replace permission filtering. Permission is still the gate; retrieval just trims the candidate set further.
- Doesn't change the router model. `mistral-small-latest` keeps doing function calling on the (now smaller) candidate set.
- Doesn't index tool *parameters* as separate vectors — they're folded into the description hash so a parameter schema change forces re-embedding, but the embedding text is the human-readable description only.
- Doesn't introduce per-tenant tool catalogs. Tools are global to hr-service; permission filter handles per-user gating.

---

## Why startup-of-hr-service, not bootstrap, not on-demand

| Approach    | Pro                                        | Con                                                                      | Verdict |
|-------------|---------------------------------------------|--------------------------------------------------------------------------|---------|
| Bootstrap   | Runs once per cluster                       | Wrong layer — bootstrap is cluster setup, not service config. Couples deploy to mistral-embed availability. Re-running bootstrap to refresh tool descriptions is heavy-handed. | ✗ |
| On-demand (lazy) | No deploy-time dependency on embedding API | First user of a fresh deploy pays the embedding latency. Race conditions across multiple bot pods. Cache invalidation in the user-request path. | ✗ |
| **hr-service startup** | Naturally couples tool registration with tool embedding (same codebase, same lifecycle). Idempotent via `description_hash`. Multi-replica safe via `INSERT ... ON CONFLICT`. Re-embedding triggered automatically by a code edit + deploy. | Adds ~6s to fresh-deploy cold start (one-time, never on subsequent restarts because hashes match). | ✓ |

Concretely: hr-service's `main.ts` already runs `seedPermissionCatalog` on startup (slice 42A). Add `seedToolEmbeddings` next to it. Same pattern, same lifecycle.

---

## Schema

```sql
-- packages/hr-service/src/db/migrations/015_tool_embeddings.sql
-- Slice 44: per-tool embedding for vector-retrieval pre-filter.
-- Global (not tenant-scoped) — tools are defined by service code, not data.

CREATE TABLE IF NOT EXISTS tool_embeddings (
  service           TEXT NOT NULL,
  tool_name         TEXT NOT NULL,
  description_hash  TEXT NOT NULL,
  embedding         vector(1024) NOT NULL,
  embedded_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (service, tool_name)
);

CREATE INDEX IF NOT EXISTS idx_tool_embeddings_cosine
  ON tool_embeddings USING hnsw (embedding vector_cosine_ops);
```

Pattern lifted from `agent_memory_vectors`. No RLS — every tool row is global.

---

## Indexer

`packages/hr-service/src/services/tool-embeddings-seed.ts`:

```ts
// Runs on hr-service startup. Walks registered tools; for each, computes
// description_hash and re-embeds only if the hash changed. Idempotent.
//
// Multi-replica safe: INSERT ... ON CONFLICT (service, tool_name)
// DO UPDATE WHERE EXCLUDED.description_hash <> tool_embeddings.description_hash.
//
// Embedding via LiteLLM `cip-embed` alias → mistral-embed. Operators can
// override per-tenant via routing_rules.

export async function seedToolEmbeddings(
  server: McpServer,
  pool:   PgPool,
): Promise<{ embedded: number; skipped: number }> { … }
```

Called from `packages/hr-service/src/main.ts` after `seedPermissionCatalog`, before the MCP server starts accepting requests.

---

## Retrieval

`packages/teams-bot/src/mcp/tool-discovery.ts`:

```ts
// Slice 44: top-K vector retrieval AFTER permission filter, BEFORE the
// router LLM sees the catalog. K=15 default (tunable via env).
//
// Empty-intersection fallback: if no permitted tool ranks in top K, return
// the full permission-filtered list. Worst case is "retrieval was useless"
// not "retrieval broke the bot."

export async function discoverTools(
  ctx:     BotAuthContext,
  message: string,           // NEW: required for retrieval
): Promise<McpTool[]> {
  // 1. cached permission-filtered list (existing logic + cache key fix)
  const permitted = await listPermittedTools(ctx);

  // 2. embed user message (LRU-cached, 256 entries, 60s TTL)
  const queryVec = await embedMessage(ctx, message);

  // 3. top-K cosine query
  const topK = await topKToolNames(queryVec, K);

  // 4. intersect; fall back to full list if empty
  const intersection = permitted.filter(t => topK.includes(t.name));
  return intersection.length > 0 ? intersection : permitted;
}
```

`bot.ts` passes the user message into `discoverTools`. The classifier's category-style cache (which was per-tenant only) goes away — retrieval is per-message, not cached.

---

## Embedding Model

| Alias       | Model           | Why                                                                  |
|-------------|------------------|----------------------------------------------------------------------|
| `cip-embed` | `mistral-embed` | 1024-dim, ~$0.10/M tokens. Stays consistent with Mistral-only policy. Mature, low-latency (~150ms). |

Per-tenant override path: insert a row in `routing_rules` with `purpose='embed'` and a different model name (e.g., `text-embedding-3-small` if a tenant insists on OpenAI). 1024 dim is the only constraint — model swap must match.

**Why not text-embedding-3-small (1536-dim):** locked in to Mistral-only by team policy; `mistral-embed` is also slightly cheaper and has comparable quality on tool-routing-style queries.

---

## Files in scope

```
packages/hr-service/src/db/migrations/015_tool_embeddings.sql      NEW
packages/hr-service/src/services/tool-embeddings-seed.ts            NEW
packages/hr-service/src/main.ts                                     (call seedToolEmbeddings on startup)
packages/teams-bot/src/mcp/tool-discovery.ts                        (retrieval step)
packages/teams-bot/src/intent/embed-cache.ts                        NEW — LRU 256/60s
packages/teams-bot/src/bot.ts                                       (pass message into discoverTools)
packages/shared/src/clients/litellm.ts                              (embedding helper if not already present)
slices/SLICE_44_TOOL_EMBEDDINGS.md                                  (this file)
slices/CONTEXT_WORKFLOW.md                                          (record slice 44 in the slice map)
```

---

## Hard Rules (Non-Negotiables)

- `tenantId: string` on every domain interface — tool_embeddings is the *only* exception (intentionally global). All other tables remain tenant-scoped.
- `description_hash` MUST be deterministic and stable. Use `sha256(name + ' ' + description + ' ' + JSON.stringify(paramSchema))`.
- The indexer MUST be idempotent. Re-runs without description changes do zero embedding API calls.
- `discoverTools` MUST handle the case where `tool_embeddings` is empty (e.g., first deploy before the indexer runs) — fall back to the full permission-filtered list silently.
- All stubs use `throw new Error('not implemented')`.

---

## Verification

**Typecheck:**
```
pnpm --filter @cip/hr-service typecheck
pnpm --filter @cip/teams-bot typecheck
pnpm --filter @cip/shared typecheck
```

**Indexer smoke test:**
1. Fresh deploy → check pod logs for `[tool-embeddings] embedded N skipped 0`.
2. Pod restart (no code change) → `[tool-embeddings] embedded 0 skipped N`.
3. Edit one tool's description, redeploy → `[tool-embeddings] embedded 1 skipped N-1`.

**Retrieval correctness** (run against deployed bot):

| Query                              | Top-1 expected                        |
|------------------------------------|----------------------------------------|
| "what are my roles"                | `get_employee_permissions`             |
| "list employees"                   | `employee_list`                        |
| "show my certifications"           | `get_my_certifications`                |
| "who has cert.submit permission"   | `permission_holders`                   |
| "create a new employee"            | `employee_create`                      |
| "list our roles"                   | `role_list`                            |

For each, log the top-15 retrieval result alongside the LLM's pick. Both should agree on the right tool.

**Cost regression check:** capture LiteLLM `usage` for ten canonical queries pre- and post-slice. Per-turn input tokens to the router should *drop* (smaller candidate set). Add the `mistral-embed` cost (~$0.0001/turn) and the cache-hit ratio.

**Latency check:** `discoverTools` adds one embedding call (~150ms) plus a pgvector lookup (~5ms). Total turn latency should rise <200ms. If embed-cache hit ratio exceeds ~30% in production, the impact is smaller.

---

## Cross-Slice Notes

- Updates the `discoverTools` cache pattern from Slice 43 (which keys by tenant+user). After Slice 44 the cache stores the *permission-filtered list*, not the retrieval result — retrieval runs per-message, never cached.
- The `cip-embed` alias is a new entry in `routing_rules`. Add a row in the migration for the dev tenant to point at `mistral-embed`.
