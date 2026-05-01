// Slice 46d part 2: nightly retention GC.
//
// Two responsibilities:
//   1. Trim the LangGraph checkpoint chain. Keep last N per thread plus
//      anything in the last K hours; delete the rest. We do NOT touch
//      checkpoint_blobs in this pass — blob version semantics (which
//      blob versions are referenced by which checkpoint's channel_versions
//      JSON) are non-trivial to validate. Conservative bound: blobs can
//      grow further until a future refinement.
//   2. Trim bot_turn_metrics rows older than the configured retention.
//
// Run inside a k8s CronJob via dist/scripts/gc.js (see helm template).
//
// Hard rules (per slice doc):
//   - Never delete a thread's only checkpoint. KEEP_PER_THREAD=10 covers
//     the worst case without needing to detect "active interrupts".
//   - GC failure is non-fatal. Exit non-zero on error so failedJobsHistoryLimit
//     retains it for inspection. Bot operation isn't affected.
//   - Idempotent. Two consecutive runs leave the tables identical.
//   - All knobs come from env vars, defaulted in code.

import pg from 'pg';

const POOL_URL = process.env['DATABASE_URL_HR'];
const KEEP_PER_THREAD     = +(process.env['GC_KEEP_PER_THREAD']        ?? '10');
const KEEP_RECENT_HOURS   = +(process.env['GC_KEEP_RECENT_HOURS']      ?? '24');
const METRICS_RETENTION_DAYS = +(process.env['GC_METRICS_RETENTION_DAYS'] ?? '90');

async function main(): Promise<void> {
  if (!POOL_URL) {
    console.error('[gc] DATABASE_URL_HR not set');
    process.exit(1);
  }

  const pool = new pg.Pool({ connectionString: POOL_URL, max: 2 });

  try {
    await trimCheckpoints(pool);
    await trimCheckpointWrites(pool);
    await trimMetrics(pool);
  } catch (err) {
    console.error(`[gc] FAILED: ${err instanceof Error ? err.stack : String(err)}`);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

async function trimCheckpoints(pool: pg.Pool): Promise<void> {
  const t0 = Date.now();
  const before = (await pool.query(`SELECT COUNT(*)::int AS n FROM checkpoints`)).rows[0].n as number;

  // Keep:
  //  - top KEEP_PER_THREAD per (thread_id, checkpoint_ns), ordered by
  //    checkpoint_id DESC. Checkpoint IDs are sortable (ULID-like) so
  //    DESC = newest first.
  //  - any checkpoint whose metadata.ts (creation timestamp) is within
  //    KEEP_RECENT_HOURS — gives debug sessions room to replay.
  const result = await pool.query(
    `
    WITH ranked AS (
      SELECT thread_id, checkpoint_ns, checkpoint_id,
             ROW_NUMBER() OVER (
               PARTITION BY thread_id, checkpoint_ns
               ORDER BY checkpoint_id DESC
             ) AS rn,
             COALESCE(
               (metadata ->> 'ts')::timestamptz,
               '-infinity'::timestamptz
             ) AS created
      FROM checkpoints
    ),
    keep AS (
      SELECT thread_id, checkpoint_ns, checkpoint_id
      FROM ranked
      WHERE rn <= $1::int
         OR created > NOW() - ($2::int || ' hours')::INTERVAL
    )
    DELETE FROM checkpoints c
     WHERE NOT EXISTS (
       SELECT 1 FROM keep k
        WHERE k.thread_id     = c.thread_id
          AND k.checkpoint_ns = c.checkpoint_ns
          AND k.checkpoint_id = c.checkpoint_id
     )
    `,
    [KEEP_PER_THREAD, KEEP_RECENT_HOURS],
  );

  const after = (await pool.query(`SELECT COUNT(*)::int AS n FROM checkpoints`)).rows[0].n as number;
  console.log(
    `[checkpoint-gc] before=${before} after=${after} ` +
    `deleted=${before - after} affected=${result.rowCount} ` +
    `keep_per_thread=${KEEP_PER_THREAD} keep_recent_hours=${KEEP_RECENT_HOURS} ` +
    `duration_ms=${Date.now() - t0}`,
  );
}

async function trimCheckpointWrites(pool: pg.Pool): Promise<void> {
  // Drop write rows orphaned by trimCheckpoints.
  const t0 = Date.now();
  const before = (await pool.query(`SELECT COUNT(*)::int AS n FROM checkpoint_writes`)).rows[0].n as number;
  const result = await pool.query(`
    DELETE FROM checkpoint_writes w
     WHERE NOT EXISTS (
       SELECT 1 FROM checkpoints c
        WHERE c.thread_id     = w.thread_id
          AND c.checkpoint_ns = w.checkpoint_ns
          AND c.checkpoint_id = w.checkpoint_id
     )
  `);
  const after = (await pool.query(`SELECT COUNT(*)::int AS n FROM checkpoint_writes`)).rows[0].n as number;
  console.log(
    `[checkpoint-writes-gc] before=${before} after=${after} ` +
    `deleted=${before - after} affected=${result.rowCount} ` +
    `duration_ms=${Date.now() - t0}`,
  );
}

async function trimMetrics(pool: pg.Pool): Promise<void> {
  const t0 = Date.now();
  const before = (await pool.query(`SELECT COUNT(*)::int AS n FROM bot_turn_metrics`)).rows[0].n as number;
  const result = await pool.query(
    `DELETE FROM bot_turn_metrics WHERE emitted_at < NOW() - ($1::int || ' days')::INTERVAL`,
    [METRICS_RETENTION_DAYS],
  );
  const after = (await pool.query(`SELECT COUNT(*)::int AS n FROM bot_turn_metrics`)).rows[0].n as number;
  console.log(
    `[metrics-gc] before=${before} after=${after} ` +
    `deleted=${before - after} affected=${result.rowCount} ` +
    `retention_days=${METRICS_RETENTION_DAYS} ` +
    `duration_ms=${Date.now() - t0}`,
  );
}

void main();
