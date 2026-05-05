// Slice 58B — runtime tunable loader for documents.* keys.
//
// Reads from cip_hr.bot_tunables (per-tenant overrides shadow the global
// row keyed on the sentinel zero UUID). Same precedence as the bot's
// runtime tunables, lifted here so doc-service activities don't have to
// reimplement the merge.
//
// Tech-debt: bot_tunables lives in cip_hr today. Doc-service has SELECT
// access via the documents-service DB user (granted alongside permission_catalog
// INSERT in the cluster bootstrap). Future "platform schema split" slice
// will move bot_tunables to a dedicated platform DB.

import { getPool } from '../db/index.js'

const GLOBAL_SENTINEL = '00000000-0000-0000-0000-000000000000'

export const DOCUMENTS_TUNABLE_KEYS = [
  'documents.l3_enabled',
  'documents.tier_override_floor',
  'documents.l1_keywords',
  'documents.av_max_file_size_mb',
  'documents.progress_subscription_ttl_seconds',
  // Slice 58C — below this confidence the classifier shunts to HITL.
  'documents.classify_confidence_threshold',
] as const
export type DocumentsTunableKey = typeof DOCUMENTS_TUNABLE_KEYS[number]

export interface DocumentsTunables {
  l3Enabled:                       boolean
  tierOverrideFloor:               'public' | 'internal' | 'confidential' | 'restricted'
  l1Keywords:                      string[]
  avMaxFileSizeMb:                 number
  progressSubscriptionTtlSeconds:  number
  /** Slice 58C — minimum classifier confidence to skip HITL admin queue. */
  classifyConfidenceThreshold:     number
}

/** Code-resident fallbacks — used when the DB row is missing entirely. */
export const DEFAULTS: DocumentsTunables = {
  l3Enabled:                       true,
  tierOverrideFloor:               'public',
  l1Keywords:                      [
    'salary','ssn','w2','w4','1099','paystub','medical','nda',
    'payroll','confidential','contract','hr-private',
  ],
  avMaxFileSizeMb:                 25,
  progressSubscriptionTtlSeconds:  300,
  classifyConfidenceThreshold:     0.75,
}

interface CacheEntry {
  value:     DocumentsTunables
  expiresAt: number
}
const TTL_MS = 5 * 60 * 1000
const cache = new Map<string, CacheEntry>()

/** Test-only: drop the per-tenant cache between cases. */
export function _resetTunablesCache(): void {
  cache.clear()
}

function asBool(v: unknown, fallback: boolean): boolean {
  if (typeof v === 'boolean') return v
  if (typeof v === 'string')  return v === 'true'
  return fallback
}
function asInt(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : fallback
}
function asNumber(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : fallback
}
function asStringArray(v: unknown, fallback: string[]): string[] {
  if (Array.isArray(v) && v.every(s => typeof s === 'string')) return v as string[]
  return fallback
}
function asTier(v: unknown, fallback: DocumentsTunables['tierOverrideFloor']): DocumentsTunables['tierOverrideFloor'] {
  if (typeof v === 'string' && (v === 'public' || v === 'internal' || v === 'confidential' || v === 'restricted')) {
    return v
  }
  return fallback
}

/**
 * Returns the merged tunables for a tenant, with 5-minute in-memory cache.
 * Single round-trip query; on any DB failure returns DEFAULTS so activities
 * don't fail just because tunables are momentarily unreachable.
 */
export async function loadDocumentsTunables(tenantId: string): Promise<DocumentsTunables> {
  const cached = cache.get(tenantId)
  if (cached && Date.now() < cached.expiresAt) return cached.value

  let merged: Record<string, unknown> = {}
  try {
    const pool = getPool()
    const result = await pool.query<{ key: string; value_json: unknown }>(
      `SELECT DISTINCT ON (key) key, value_json
         FROM bot_tunables
        WHERE tenant_id = $1 OR tenant_id = $2
          AND key = ANY($3::text[])
        ORDER BY key, (tenant_id = $1) DESC`,
      [tenantId, GLOBAL_SENTINEL, [...DOCUMENTS_TUNABLE_KEYS]],
    )
    for (const row of result.rows) merged[row.key] = row.value_json
  } catch (err) {
    console.warn(`[tunables] load failed for tenant=${tenantId}: ${err instanceof Error ? err.message : String(err)} — using DEFAULTS`)
    merged = {}
  }

  const value: DocumentsTunables = {
    l3Enabled:                       asBool(merged['documents.l3_enabled'], DEFAULTS.l3Enabled),
    tierOverrideFloor:               asTier(merged['documents.tier_override_floor'], DEFAULTS.tierOverrideFloor),
    l1Keywords:                      asStringArray(merged['documents.l1_keywords'], DEFAULTS.l1Keywords),
    avMaxFileSizeMb:                 asInt(merged['documents.av_max_file_size_mb'], DEFAULTS.avMaxFileSizeMb),
    progressSubscriptionTtlSeconds:  asInt(merged['documents.progress_subscription_ttl_seconds'], DEFAULTS.progressSubscriptionTtlSeconds),
    classifyConfidenceThreshold:     asNumber(merged['documents.classify_confidence_threshold'], DEFAULTS.classifyConfidenceThreshold),
  }

  cache.set(tenantId, { value, expiresAt: Date.now() + TTL_MS })
  return value
}
