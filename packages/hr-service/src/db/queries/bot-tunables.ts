import type { PoolClient } from 'pg';

export interface BotTunable {
  key:        string;
  /** JSONB — could be a string, number, boolean, or array. Caller casts. */
  value:      unknown;
  notes:      string | null;
  updatedAt:  Date;
}

/**
 * Fetch the merged tunable set for a tenant — per-tenant rows (where set)
 * shadow the global NULL-tenant defaults. Returned as a flat map:
 *   { 'lg.max_steps': 5, 'lg.affirmation_patterns': [...], ... }
 *
 * Single round-trip query. Bot caches per-tenant for 5 minutes.
 */
export async function getBotTunables(
  client:   PoolClient,
  tenantId: string,
): Promise<Record<string, unknown>> {
  // Pull both global defaults (sentinel zero UUID) and per-tenant rows.
  // DISTINCT ON keeps one row per key; ORDER BY puts the per-tenant row
  // first when both exist.
  const GLOBAL_SENTINEL = '00000000-0000-0000-0000-000000000000';
  const result = await client.query<{ key: string; value_json: unknown }>(
    `SELECT DISTINCT ON (key) key, value_json
       FROM bot_tunables
      WHERE tenant_id = $1 OR tenant_id = $2
      ORDER BY key, (tenant_id = $1) DESC`,
    [tenantId, GLOBAL_SENTINEL],
  );
  const out: Record<string, unknown> = {};
  for (const row of result.rows) {
    out[row.key] = row.value_json;
  }
  return out;
}
