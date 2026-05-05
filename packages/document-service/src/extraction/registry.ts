// Slice 58C — extraction strategy resolver.
//
// Reads from cip_documents.extraction_strategies. Hard rule #1
// (memory): the registry is a DB table, never a code map. Tenants
// override platform defaults by inserting a row scoped to their
// tenant_id; the resolver falls back through the four-tier lookup
// and returns the first enabled match.
//
// Resolution order:
//   1. (tenant_id,         module, doc_type)   — tenant-specific override
//   2. (tenant_id,         module, '*')        — tenant module-wide override
//   3. (zero-UUID,         module, doc_type)   — platform-default specific
//   4. (zero-UUID,         module, '*')        — platform-default catchall
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
}

/**
 * Resolve the strategy for (tenantId, module, docType) using the
 * four-tier fallback. Returns null when no enabled row matches.
 *
 * Single round-trip — fetches up to 4 candidate rows in one query and
 * picks the most-specific enabled one in code. Cheaper than 4 sequential
 * queries; the table is tiny (~ rows-per-tenant × number-of-modules).
 */
export async function resolveStrategy(
  tenantId: string,
  module:   string,
  docType:  string,
): Promise<ResolvedStrategy | null> {
  const pool = getPool()
  const result = await pool.query<StrategyRow>(
    `SELECT tenant_id, module, doc_type, strategy_name, task_queue, activity_name, config_json, enabled
       FROM cip_documents.extraction_strategies
      WHERE module = $2
        AND (tenant_id = $1 OR tenant_id = $4::uuid)
        AND (doc_type = $3 OR doc_type = '*')`,
    [tenantId, module, docType, GLOBAL_SENTINEL],
  )

  // Specificity: tenant > zero-UUID, exact doc_type > '*'.
  const score = (r: StrategyRow): number =>
    (r.tenant_id === tenantId ? 2 : 0) + (r.doc_type === docType ? 1 : 0)

  const candidates = result.rows
    .filter((r): r is StrategyRow => r.enabled)
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
  }
}
