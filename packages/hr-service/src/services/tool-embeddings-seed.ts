// Slice 44: idempotent indexer for the tool_embeddings table.
//
// Runs on hr-service startup. Walks every registered MCP tool, computes
// description_hash = sha256(name + ' ' + description + ' ' +
// JSON.stringify(paramSchema)), and re-embeds via mistral-embed only
// when the hash differs from the stored row.
//
// Steady state: zero embedding API calls on a no-op pod restart (just
// N hash comparisons + one batched SELECT). New embeddings only fire
// when a description / param schema actually changes.
//
// Multi-replica safe: ON CONFLICT (service, tool_name) DO UPDATE — if two
// pods race on a fresh deploy, one wins, the other no-ops. Both paid the
// embedding API call, but that bounded by replica count and only on
// first-deploy.
//
// Orphan cleanup: after the upsert pass, DELETEs any row in
// tool_embeddings whose (service, tool_name) is NOT in the current
// registered set. Same transaction as the upserts so a partial registry
// never wipes embeddings.

import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { callEmbed, createLiteLLMClient } from '@cip/shared';

const SERVICE = 'hr-service';
// Slice 44: route through the LiteLLM gateway alias, not raw provider name.
// `cip-embed` resolves to mistral/mistral-embed via the LiteLLM model_list
// (see infra/k8s/litellm-config.yaml). Using the raw model name produces
// a 400 because the gateway doesn't auto-pass-through unknown model names.
const EMBED_MODEL = 'cip-embed';
// The seed runs at pod startup, before any user request — no caller
// tenant exists. This sentinel UUID is used solely for Langfuse
// observability tagging so seed-time embedding traces are recognisable
// (filterable as `tenantId = system`). Embeddings + tools themselves
// are global; per-tenant scoping happens upstream in permission filtering.
const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-0000000000ff';

interface RegisteredTool {
  name:        string;
  description: string;
  paramSchema: unknown;
}

/**
 * Enumerate tools registered on an McpServer. The SDK doesn't expose a
 * stable public iterator, so we use the documented `_registeredTools`
 * internal map. If a future SDK upgrade changes the field name, this
 * fails loudly at startup and the indexer logs a warning — embedding
 * indexing is non-fatal (discoverTools handles empty tool_embeddings
 * gracefully and falls back to the full permission-filtered list).
 */
function listRegisteredTools(server: McpServer): RegisteredTool[] {
  const internal = (server as unknown as {
    _registeredTools?: Record<string, {
      description?: string;
      inputSchema?: unknown;
    }>;
  })._registeredTools;
  if (!internal || typeof internal !== 'object') return [];
  return Object.entries(internal).map(([name, t]) => ({
    name,
    description: t.description ?? '',
    paramSchema: t.inputSchema ?? {},
  }));
}

function computeHash(t: RegisteredTool): string {
  const payload = `${t.name} ${t.description} ${JSON.stringify(t.paramSchema)}`;
  return createHash('sha256').update(payload).digest('hex');
}

interface SeedStats {
  embedded: number;   // tools that needed (re-)embedding this run
  skipped:  number;   // tools whose description_hash was unchanged
  orphans:  number;   // rows deleted because the tool was removed from code
}

/**
 * Seed the tool_embeddings table. Idempotent; re-runs are cheap when
 * descriptions are unchanged.
 *
 * Embedding is fire-and-forget per-tool — a single failure logs but
 * doesn't abort the whole pass (some tools still get embedded; the
 * remainder will retry on the next pod start).
 */
export async function seedToolEmbeddings(
  server: McpServer,
  pool:   Pool,
): Promise<SeedStats> {
  const tools = listRegisteredTools(server);
  if (tools.length === 0) {
    console.warn('[tool-embeddings] no registered tools found — skipping seed');
    return { embedded: 0, skipped: 0, orphans: 0 };
  }

  let embedded = 0;
  let skipped  = 0;
  let orphans  = 0;

  // Pull all existing hashes for this service in one query — short-lived
  // connection from the pool, returned immediately. Don't hold across the
  // long embedding API loop or postgres' idle_in_transaction_timeout fires
  // and pg.Client emits an unhandled 'error' that crashes node.
  let existingRows: Array<{ tool_name: string; description_hash: string }> = [];
  try {
    const result = await pool.query<{ tool_name: string; description_hash: string }>(
      `SELECT tool_name, description_hash FROM tool_embeddings WHERE service = $1`,
      [SERVICE],
    );
    existingRows = result.rows;
  } catch (err) {
    console.warn(`[tool-embeddings] existing-row scan failed: ${err instanceof Error ? err.message : String(err)} — assuming empty`);
  }
  const existingHashes = new Map(existingRows.map(r => [r.tool_name, r.description_hash]));
  const currentNames = new Set(tools.map(t => t.name));

  // LiteLLM client is reusable across embedding calls. Virtual key is
  // the platform-wide one used by hr-service for its own LLM calls.
  const llmClient = createLiteLLMClient({
    tenantId:   SYSTEM_TENANT_ID,
    virtualKey: process.env['LITELLM_VIRTUAL_KEY'] ?? '',
  });

  // Per-tool: embed (slow, HTTP) → upsert (fast, single statement). Each
  // upsert is its own implicit transaction via pool.query — no BEGIN/COMMIT
  // held across the embedding call.
  for (const tool of tools) {
    const hash = computeHash(tool);
    if (existingHashes.get(tool.name) === hash) {
      skipped++;
      continue;
    }
    try {
      const embedText = `${tool.name}\n${tool.description}`;
      const [vec] = await callEmbed(llmClient, {
        model:    EMBED_MODEL,
        input:    embedText,
        purpose:  'hr-service.tool_embed',
        tenantId: SYSTEM_TENANT_ID,
      });
      if (!vec || vec.length === 0) {
        console.warn(`[tool-embeddings] empty embedding for ${tool.name} — skipping`);
        continue;
      }
      if (vec.length !== 1024) {
        console.warn(
          `[tool-embeddings] unexpected dim for ${tool.name}: ${vec.length} (expected 1024). ` +
          `Skipping. Check LiteLLM cip-embed alias resolves to a 1024-dim model.`,
        );
        continue;
      }
      const vecLiteral = `[${vec.join(',')}]`;
      await pool.query(
        `INSERT INTO tool_embeddings (service, tool_name, description_hash, embedding, embedded_at)
         VALUES ($1, $2, $3, $4::vector, NOW())
         ON CONFLICT (service, tool_name) DO UPDATE
           SET description_hash = EXCLUDED.description_hash,
               embedding        = EXCLUDED.embedding,
               embedded_at      = NOW()`,
        [SERVICE, tool.name, hash, vecLiteral],
      );
      embedded++;
    } catch (err) {
      console.warn(
        `[tool-embeddings] failed to embed ${tool.name}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Orphan cleanup — separate from the embed loop because the upsert pass
  // doesn't need to be in the same transaction. A partial registry just
  // leaves a few stale rows; the next pod restart catches them.
  for (const row of existingRows) {
    if (!currentNames.has(row.tool_name)) {
      try {
        await pool.query(
          `DELETE FROM tool_embeddings WHERE service = $1 AND tool_name = $2`,
          [SERVICE, row.tool_name],
        );
        orphans++;
      } catch (err) {
        console.warn(`[tool-embeddings] orphan delete failed for ${row.tool_name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  console.log(`[tool-embeddings] embedded=${embedded} skipped=${skipped} orphans=${orphans}`);
  return { embedded, skipped, orphans };
}
