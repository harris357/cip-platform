// Slice 57B: checkpoint + metrics retention activities. Wraps the
// existing per-table GC logic from packages/hr-service/src/scripts/gc.ts
// as three independently-retriable Temporal activities.
//
// Each activity returns structured before/after counts so the workflow
// can record them in Temporal Web UI history. Independent retries mean
// a transient failure on one DELETE doesn't block the others for a
// full day (the cron-script approach: any error → exit 1, three days
// of accumulation before next run).

import { z } from 'zod';
import { getPool } from '../../../db/index.js';

// ── Common output shape ──────────────────────────────────────────────

const GcResultOutput = z.object({
  before:     z.number().int().nonnegative(),
  after:      z.number().int().nonnegative(),
  deleted:    z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
});
type GcResultOutput = z.infer<typeof GcResultOutput>;

// ── trimCheckpointsActivity ──────────────────────────────────────────

const TrimCheckpointsInput = z.object({
  keepPerThread:    z.number().int().min(1).max(100).default(10),
  keepRecentHours:  z.number().int().min(1).max(168).default(24),
});

export async function trimCheckpointsActivity(
  input: z.input<typeof TrimCheckpointsInput>,
): Promise<GcResultOutput> {
  const args = TrimCheckpointsInput.parse(input);
  const t0 = Date.now();
  const pool = getPool();

  const before = (await pool.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM checkpoints`,
  )).rows[0]!.n;

  // Keep top KEEP_PER_THREAD per (thread_id, checkpoint_ns) ordered by
  // checkpoint_id DESC, plus any checkpoint whose metadata.ts is within
  // KEEP_RECENT_HOURS. Same logic as scripts/gc.ts:trimCheckpoints.
  await pool.query(
    `WITH ranked AS (
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
      )`,
    [args.keepPerThread, args.keepRecentHours],
  );

  const after = (await pool.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM checkpoints`,
  )).rows[0]!.n;

  return GcResultOutput.parse({
    before,
    after,
    deleted:    before - after,
    durationMs: Date.now() - t0,
  });
}

// ── trimCheckpointWritesActivity ─────────────────────────────────────

export async function trimCheckpointWritesActivity(): Promise<GcResultOutput> {
  const t0 = Date.now();
  const pool = getPool();

  const before = (await pool.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM checkpoint_writes`,
  )).rows[0]!.n;

  // Drop writes orphaned by trimCheckpointsActivity (must run AFTER it).
  await pool.query(`
    DELETE FROM checkpoint_writes w
     WHERE NOT EXISTS (
       SELECT 1 FROM checkpoints c
        WHERE c.thread_id     = w.thread_id
          AND c.checkpoint_ns = w.checkpoint_ns
          AND c.checkpoint_id = w.checkpoint_id
     )
  `);

  const after = (await pool.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM checkpoint_writes`,
  )).rows[0]!.n;

  return GcResultOutput.parse({
    before,
    after,
    deleted:    before - after,
    durationMs: Date.now() - t0,
  });
}

// ── trimMetricsActivity ──────────────────────────────────────────────

const TrimMetricsInput = z.object({
  retentionDays: z.number().int().min(1).max(3650).default(90),
});

export async function trimMetricsActivity(
  input: z.input<typeof TrimMetricsInput>,
): Promise<GcResultOutput> {
  const args = TrimMetricsInput.parse(input);
  const t0 = Date.now();
  const pool = getPool();

  const before = (await pool.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM bot_turn_metrics`,
  )).rows[0]!.n;

  await pool.query(
    `DELETE FROM bot_turn_metrics WHERE emitted_at < NOW() - ($1::int || ' days')::INTERVAL`,
    [args.retentionDays],
  );

  const after = (await pool.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM bot_turn_metrics`,
  )).rows[0]!.n;

  return GcResultOutput.parse({
    before,
    after,
    deleted:    before - after,
    durationMs: Date.now() - t0,
  });
}
