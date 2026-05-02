// Slice 48: best-effort turn-metrics writer.
//
// runLangGraph calls this AFTER sending the user reply. DB write
// failures only log; the turn already succeeded. The [turn] structured
// log line remains the durable backup if the DB is unavailable.
//
// Connection re-uses the same DATABASE_URL_HR the checkpointer uses
// (Slice 46). Single shared pg.Pool with modest size — turn-metrics
// writes are infrequent (one per turn).

import pg from 'pg';

const POOL_URL = process.env['DATABASE_URL_HR'];

let pool: pg.Pool | null = null;
function getPool(): pg.Pool | null {
  if (!POOL_URL) return null;
  if (!pool) {
    pool = new pg.Pool({
      connectionString: POOL_URL,
      max:              4,
      idleTimeoutMillis: 30_000,
    });
  }
  return pool;
}

export interface TurnMetric {
  turnId:             string;
  tenantId:           string;
  threadId:           string;
  employeeId:         string;
  intent:             string;
  toolsAttempted:     string[];
  toolsRefused:       string[];
  stepCount:          number;
  triageConfidence:   number | null;
  clarificationFired: boolean;
  confirmationFired:  boolean;
  resumed:            boolean;
  totalMs:            number;
  graphMs:            number;
  langfuseTraceId:    string | null;
  sessionId:          string | null;
}

export async function writeTurnMetric(m: TurnMetric): Promise<void> {
  const p = getPool();
  if (!p) {
    console.warn('[turn-metrics] DATABASE_URL_HR missing — skipping write');
    return;
  }
  try {
    await p.query(
      `INSERT INTO bot_turn_metrics
         (turn_id, tenant_id, thread_id, employee_id, intent,
          tools_attempted, tools_refused, step_count, triage_confidence,
          clarification_fired, confirmation_fired, resumed,
          total_ms, graph_ms, langfuse_trace_id, session_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       ON CONFLICT (turn_id) DO NOTHING`,
      [
        m.turnId, m.tenantId, m.threadId, m.employeeId, m.intent,
        m.toolsAttempted, m.toolsRefused, m.stepCount, m.triageConfidence,
        m.clarificationFired, m.confirmationFired, m.resumed,
        m.totalMs, m.graphMs, m.langfuseTraceId, m.sessionId,
      ],
    );
  } catch (err) {
    console.warn(
      `[turn-metrics] write failed (turn=${m.turnId}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
