// Slice 46e: shared SQL helpers for the bot_turn_metrics table.
//
// The five admin MCP tools (bot_metrics_*) and the /turn slash command
// route through these. All queries are tenant-scoped — the caller
// passes ctx.tenantId explicitly; we never derive it from elsewhere.
//
// Time windows are normalized via parseSince(): only known shorthand
// like '1h', '24h', '7d', '30d' is accepted. Anything else throws.

import type pg from 'pg';

export type TimeWindow = '1h' | '6h' | '24h' | '7d' | '30d';

export function parseSince(input: string): TimeWindow {
  const allowed: TimeWindow[] = ['1h', '6h', '24h', '7d', '30d'];
  const v = (input || '').trim().toLowerCase();
  if ((allowed as string[]).includes(v)) return v as TimeWindow;
  throw new Error(`since must be one of ${allowed.join(',')}; got "${input}"`);
}

function intervalFor(w: TimeWindow): string {
  return w; // Postgres can parse '1h' / '24h' / '7d' / '30d' via INTERVAL
}

export interface TurnRow {
  turn_id:             string;
  tenant_id:           string;
  thread_id:           string;
  employee_id:         string;
  emitted_at:          Date;
  intent:              string;
  tools_attempted:     string[];
  tools_refused:       string[];
  step_count:          number;
  triage_confidence:   number | null;
  clarification_fired: boolean;
  confirmation_fired:  boolean;
  resumed:             boolean;
  total_ms:            number;
  graph_ms:            number;
}

export async function getTurn(
  pool: pg.Pool,
  args: { tenantId: string; turnId: string },
): Promise<TurnRow | null> {
  const { rows } = await pool.query<TurnRow>(
    `SELECT * FROM bot_turn_metrics
      WHERE turn_id = $1 AND tenant_id = $2`,
    [args.turnId, args.tenantId],
  );
  return rows[0] ?? null;
}

export interface SummaryRow {
  turns:               number;
  p50_total_ms:        number;
  p95_total_ms:        number;
  p99_total_ms:        number;
  p50_graph_ms:        number;
  p95_graph_ms:        number;
  intent_ask:          number;
  intent_direct:       number;
  intent_tool:         number;
  intent_unknown:      number;
  with_refusals:       number;
  with_confirmations:  number;
  with_resumes:        number;
}

export async function getSummary(
  pool: pg.Pool,
  args: { tenantId: string; since: TimeWindow },
): Promise<SummaryRow> {
  const { rows } = await pool.query<SummaryRow>(
    `SELECT
       COUNT(*)::int                                                                  AS turns,
       COALESCE(PERCENTILE_CONT(0.5)  WITHIN GROUP (ORDER BY total_ms)::int, 0)       AS p50_total_ms,
       COALESCE(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY total_ms)::int, 0)       AS p95_total_ms,
       COALESCE(PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY total_ms)::int, 0)       AS p99_total_ms,
       COALESCE(PERCENTILE_CONT(0.5)  WITHIN GROUP (ORDER BY graph_ms)::int, 0)       AS p50_graph_ms,
       COALESCE(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY graph_ms)::int, 0)       AS p95_graph_ms,
       COUNT(*) FILTER (WHERE intent = 'ask')::int                                     AS intent_ask,
       COUNT(*) FILTER (WHERE intent = 'direct')::int                                  AS intent_direct,
       COUNT(*) FILTER (WHERE intent = 'tool')::int                                    AS intent_tool,
       COUNT(*) FILTER (WHERE intent = 'unknown')::int                                 AS intent_unknown,
       COUNT(*) FILTER (WHERE array_length(tools_refused, 1) > 0)::int                 AS with_refusals,
       COUNT(*) FILTER (WHERE confirmation_fired)::int                                 AS with_confirmations,
       COUNT(*) FILTER (WHERE resumed)::int                                            AS with_resumes
       FROM bot_turn_metrics
      WHERE tenant_id = $1
        AND emitted_at > NOW() - $2::INTERVAL`,
    [args.tenantId, intervalFor(args.since)],
  );
  return rows[0]!;
}

export type TopMetric = 'total_ms' | 'graph_ms' | 'step_count';

export async function getTopN(
  pool: pg.Pool,
  args: { tenantId: string; since: TimeWindow; metric: TopMetric; limit: number; intent?: string | undefined },
): Promise<Array<Pick<TurnRow, 'turn_id' | 'emitted_at' | 'intent' | 'total_ms' | 'graph_ms' | 'step_count' | 'tools_attempted'>>> {
  if (!['total_ms', 'graph_ms', 'step_count'].includes(args.metric)) {
    throw new Error(`metric must be one of total_ms / graph_ms / step_count`);
  }
  const limit = Math.min(50, Math.max(1, args.limit));
  const params: Array<string | number> = [args.tenantId, intervalFor(args.since), limit];
  let intentFilter = '';
  if (args.intent) {
    params.push(args.intent);
    intentFilter = ` AND intent = $${params.length}`;
  }
  const { rows } = await pool.query(
    `SELECT turn_id, emitted_at, intent, total_ms, graph_ms, step_count, tools_attempted
       FROM bot_turn_metrics
      WHERE tenant_id = $1
        AND emitted_at > NOW() - $2::INTERVAL${intentFilter}
      ORDER BY ${args.metric} DESC
      LIMIT $3`,
    params,
  );
  return rows;
}

export interface ToolUsageRow {
  tool:           string;
  calls:          number;
  refusals:       number;
  refusal_pct:    number;
  avg_graph_ms:   number;
  p95_graph_ms:   number;
}

export async function getToolUsage(
  pool: pg.Pool,
  args: { tenantId: string; since: TimeWindow },
): Promise<ToolUsageRow[]> {
  // Unnest tools_attempted to get per-tool counts. Refusal is flagged
  // when the same name appears in tools_refused on that row.
  const { rows } = await pool.query<ToolUsageRow>(
    `WITH per_tool AS (
       SELECT unnest(tools_attempted) AS tool,
              graph_ms,
              tools_refused
         FROM bot_turn_metrics
        WHERE tenant_id = $1
          AND emitted_at > NOW() - $2::INTERVAL
     )
     SELECT tool,
            COUNT(*)::int                                              AS calls,
            COUNT(*) FILTER (WHERE tool = ANY(tools_refused))::int     AS refusals,
            (100.0 * COUNT(*) FILTER (WHERE tool = ANY(tools_refused)) / COUNT(*))::int AS refusal_pct,
            AVG(graph_ms)::int                                         AS avg_graph_ms,
            COALESCE(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY graph_ms)::int, 0) AS p95_graph_ms
       FROM per_tool
      GROUP BY tool
      ORDER BY calls DESC
      LIMIT 50`,
    [args.tenantId, intervalFor(args.since)],
  );
  return rows;
}

export interface OutlierRow {
  turn_id:    string;
  emitted_at: Date;
  intent:     string;
  total_ms:   number;
  step_count: number;
  reasons:    string[];   // ['refusal', 'high_steps', 'low_triage_confidence', 'high_latency', 'abandoned_confirm']
}

export async function getOutliers(
  pool: pg.Pool,
  args: { tenantId: string; since: TimeWindow },
): Promise<OutlierRow[]> {
  const { rows } = await pool.query(
    `WITH bounds AS (
       SELECT COALESCE(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY total_ms)::int, 0) AS p95_total_ms
         FROM bot_turn_metrics
        WHERE tenant_id = $1
          AND emitted_at > NOW() - $2::INTERVAL
     )
     SELECT m.turn_id,
            m.emitted_at,
            m.intent,
            m.total_ms,
            m.step_count,
            ARRAY_REMOVE(ARRAY[
              CASE WHEN array_length(m.tools_refused, 1) > 0  THEN 'refusal'                ELSE NULL END,
              CASE WHEN m.step_count >= 3                     THEN 'high_steps'             ELSE NULL END,
              CASE WHEN m.triage_confidence IS NOT NULL AND m.triage_confidence < 0.5 THEN 'low_triage_confidence' ELSE NULL END,
              CASE WHEN m.total_ms > b.p95_total_ms           THEN 'high_latency'           ELSE NULL END,
              CASE WHEN m.confirmation_fired AND NOT m.resumed THEN 'abandoned_confirm'     ELSE NULL END
            ], NULL) AS reasons
       FROM bot_turn_metrics m
       CROSS JOIN bounds b
      WHERE m.tenant_id = $1
        AND m.emitted_at > NOW() - $2::INTERVAL
        AND (
          array_length(m.tools_refused, 1) > 0
          OR m.step_count >= 3
          OR (m.triage_confidence IS NOT NULL AND m.triage_confidence < 0.5)
          OR m.total_ms > b.p95_total_ms
          OR (m.confirmation_fired AND NOT m.resumed)
        )
      ORDER BY m.emitted_at DESC
      LIMIT 25`,
    [args.tenantId, intervalFor(args.since)],
  );
  return rows;
}
