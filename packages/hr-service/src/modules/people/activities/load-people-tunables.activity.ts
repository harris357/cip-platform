// Slice 58D-A — load matcher tunables once at workflow entry.
//
// The 5 tunables seeded by 043_match_person_tunables.sql are read here
// in a single trip; downstream activities receive them as args so the
// workflow's deterministic-replay guarantees don't depend on per-step
// reads. Mid-flight tunable changes are not honoured until the next
// workflow run (per slice doc hard rule #9).

import { z } from 'zod';
import { getPool } from '../../../db/index.js';

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

const DEFAULTS = {
  autoThreshold:      0.9,
  uploaderTtlHours:   24,
  adminTtlHours:      168,
  shortlistMax:       5,
  canonicalizeModel:  'cip-classifier',
} as const;

const KEYS = {
  autoThreshold:     'hr.person_match_auto_threshold',
  uploaderTtlHours:  'hr.person_match_uploader_ttl_hours',
  adminTtlHours:     'hr.person_match_admin_ttl_hours',
  shortlistMax:      'hr.person_match_shortlist_max',
  canonicalizeModel: 'hr.person_match_canonicalize_model',
} as const;

export const PeopleTunablesSchema = z.object({
  autoThreshold:     z.number().min(0).max(1),
  uploaderTtlHours:  z.number().int().positive(),
  adminTtlHours:     z.number().int().positive(),
  shortlistMax:      z.number().int().positive(),
  canonicalizeModel: z.string().min(1),
});
export type PeopleTunables = z.infer<typeof PeopleTunablesSchema>;

export interface LoadPeopleTunablesInput {
  tenantId: string;
}

function asNumber(v: unknown, fallback: number): number {
  if (typeof v === 'number') return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function asString(v: unknown, fallback: string): string {
  if (typeof v === 'string') return v;
  return fallback;
}

/**
 * Single round-trip read of the 5 matcher tunables, with per-tenant
 * shadowing the zero-UUID defaults. Failure = log + return defaults
 * (the matcher is non-critical and a single bad row shouldn't kill the
 * whole workflow).
 */
export async function loadPeopleTunablesActivity(
  input: LoadPeopleTunablesInput,
): Promise<PeopleTunables> {
  let raw: Record<string, unknown> = {};
  try {
    const pool = getPool();
    const r = await pool.query<{ key: string; value_json: unknown }>(
      `SELECT DISTINCT ON (key) key, value_json
         FROM bot_tunables
        WHERE key = ANY($1)
          AND (tenant_id = $2 OR tenant_id = $3::uuid)
        ORDER BY key, (tenant_id = $2) DESC`,
      [Object.values(KEYS), input.tenantId, ZERO_UUID],
    );
    for (const row of r.rows) {
      raw[row.key] = row.value_json;
    }
  } catch (err) {
    console.warn(`[people-tunables] read failed: ${err instanceof Error ? err.message : String(err)} — using defaults`);
    raw = {};
  }

  return PeopleTunablesSchema.parse({
    autoThreshold:     asNumber(raw[KEYS.autoThreshold],     DEFAULTS.autoThreshold),
    uploaderTtlHours:  asNumber(raw[KEYS.uploaderTtlHours],  DEFAULTS.uploaderTtlHours),
    adminTtlHours:     asNumber(raw[KEYS.adminTtlHours],     DEFAULTS.adminTtlHours),
    shortlistMax:      asNumber(raw[KEYS.shortlistMax],      DEFAULTS.shortlistMax),
    canonicalizeModel: asString(raw[KEYS.canonicalizeModel], DEFAULTS.canonicalizeModel),
  });
}
