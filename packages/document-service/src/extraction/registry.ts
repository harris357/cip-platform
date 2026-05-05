// Slice 58C — extraction strategy resolver.
// Slice 58E — added MIME-filter awareness (phase 2 of MIME-aware
// extraction). Resolver now scores `mime_filter` against the doc's
// classified MIME class.
//
// Reads from cip_documents.extraction_strategies. Hard rule #1
// (memory): the registry is a DB table, never a code map. Tenants
// override platform defaults by inserting a row scoped to their
// tenant_id; the resolver falls back through the four-tier lookup
// and returns the first enabled match.
//
// Resolution order (most-specific wins on a weighted score):
//   1. (tenant_id,         module, doc_type)   — tenant-specific override
//   2. (tenant_id,         module, '*')        — tenant module-wide override
//   3. (zero-UUID,         module, doc_type)   — platform-default specific
//   4. (zero-UUID,         module, '*')        — platform-default catchall
//
// Within each tier, a row whose `mime_filter` matches the doc's MIME
// class beats one with `mime_filter=NULL` (which still matches as a
// catch-all). Rows whose `mime_filter` is set to a different MIME class
// are filtered out entirely.
//
// Rows with enabled=false are skipped at every level. Returns null when
// no enabled strategy matches — the caller decides what to do (today
// the workflow lands the doc in hitl_admin_queue with reason
// 'no_extraction_strategy').

import { getPool } from '../db/index.js'

const GLOBAL_SENTINEL = '00000000-0000-0000-0000-000000000000'

export interface ResolvedStrategy {
  tenantId:      string         // matched row's tenant (tenant or zero-UUID)
  module:        string
  docType:       string         // matched row's doc_type ('*' if catchall)
  strategyName:  string
  taskQueue:     string
  activityName:  string
  configJson:    Record<string, unknown>
  /** Slice 58E — null if the row applies to every MIME class. */
  mimeFilter:    string | null
}

interface StrategyRow {
  tenant_id:     string
  module:        string
  doc_type:      string
  strategy_name: string
  task_queue:    string
  activity_name: string
  config_json:   Record<string, unknown> | null
  enabled:       boolean
  mime_filter:   string | null
}

/**
 * Resolve the strategy for (tenantId, module, docType, mimeClass) using
 * the four-tier fallback. Returns null when no enabled row matches.
 *
 * Single round-trip — fetches up to 4 candidate rows in one query and
 * picks the most-specific enabled one in code. Cheaper than 4 sequential
 * queries; the table is tiny (~ rows-per-tenant × number-of-modules).
 *
 * Slice 58E — `mimeClass` is the canonical MimeClass string returned
 * by `classify-mime.classifyMime()`. Pass `'unknown'` (or anything not
 * a real class) for callers that don't have a MIME and want NULL-only
 * matches.
 */
export async function resolveStrategy(
  tenantId: string,
  module:   string,
  docType:  string,
  mimeClass?: string,
): Promise<ResolvedStrategy | null> {
  const pool = getPool()
  // Widen the SELECT to include mime_filter; filtering happens in code so
  // we keep the single-round-trip pattern.
  const result = await pool.query<StrategyRow>(
    `SELECT tenant_id, module, doc_type, strategy_name, task_queue, activity_name, config_json, enabled, mime_filter
       FROM cip_documents.extraction_strategies
      WHERE module = $2
        AND (tenant_id = $1 OR tenant_id = $4::uuid)
        AND (doc_type = $3 OR doc_type = '*')`,
    [tenantId, module, docType, GLOBAL_SENTINEL],
  )

  // Specificity score:
  //   tenant-specific tenant: +4   (vs zero-UUID)
  //   exact doc_type:         +2   (vs '*' wildcard)
  //   exact mime_filter:      +1   (vs NULL catchall)
  // mime_filter set to a different class is filtered before scoring.
  // Bumped weights ensure tier order (tenant > docType > mime) is preserved
  // even when a higher-tier row has NULL mime_filter and a lower-tier row
  // has an exact mime_filter match.
  const score = (r: StrategyRow): number =>
    (r.tenant_id === tenantId ? 4 : 0)
    + (r.doc_type === docType ? 2 : 0)
    + (mimeClass !== undefined && r.mime_filter === mimeClass ? 1 : 0)

  const candidates = result.rows
    .filter((r): r is StrategyRow => r.enabled)
    // mime_filter set but not matching → exclude. NULL mime_filter → keep
    // (catch-all). When caller passed no mimeClass, only NULL rows match
    // (preserves pre-58E behavior).
    .filter((r) => {
      if (r.mime_filter === null) return true
      if (mimeClass === undefined) return false
      return r.mime_filter === mimeClass
    })
    .sort((a, b) => score(b) - score(a))

  const top = candidates[0]
  if (!top) return null

  return {
    tenantId:     top.tenant_id,
    module:       top.module,
    docType:      top.doc_type,
    strategyName: top.strategy_name,
    taskQueue:    top.task_queue,
    activityName: top.activity_name,
    configJson:   top.config_json ?? {},
    mimeFilter:   top.mime_filter,
  }
}
