// Slice 57B: nightly retention GC as a Temporal workflow.
//
// Replaces the cron-script approach (packages/hr-service/src/scripts/gc.ts
// invoked from packages/hr-service/helm/templates/checkpoint-gc-cronjob.yaml).
// Per the slice 56N + Temporal audit conventions:
//   - Each DELETE is its own activity → independent retry semantics
//   - Total run is observable in Temporal Web UI (vs grep-the-pod-logs)
//   - Output (before/after/deleted counts per table) is structured workflow
//     output, queryable + persisted
//   - GC failures are non-fatal to bot operation but a Temporal workflow
//     failure is logged + surfaced; visible to ops without paging.
//
// Workflow ID pattern: CheckpointGc-platform-{date}
// Triggered by: a thin K8s CronJob (preserves existing cron infra) that
//   posts to a small workflow-trigger endpoint, OR by an admin via
//   `temporal workflow start` for ad-hoc cleanup.

import { proxyActivities, log } from '@temporalio/workflow';
import type * as activities from '../activities/index.js';

const {
  trimCheckpointsActivity,
  trimCheckpointWritesActivity,
  trimMetricsActivity,
} = proxyActivities<typeof activities>({
  startToCloseTimeout: '15 minutes',
  retry: {
    maximumAttempts: 3,
    initialInterval: '10 seconds',
  },
});

export interface CheckpointGcWorkflowInput {
  /** Default 10. KEEP_PER_THREAD floor below which checkpoints are
   *  pruned. */
  keepPerThread?:    number;
  /** Default 24. Hours of recent checkpoint history kept regardless
   *  of keepPerThread. */
  keepRecentHours?:  number;
  /** Default 90. bot_turn_metrics rows older than this are pruned. */
  metricsRetentionDays?: number;
}

export interface CheckpointGcWorkflowOutput {
  checkpoints:        { before: number; after: number; deleted: number; durationMs: number };
  checkpoint_writes:  { before: number; after: number; deleted: number; durationMs: number };
  bot_turn_metrics:   { before: number; after: number; deleted: number; durationMs: number };
}

export async function CheckpointGcWorkflow(
  input: CheckpointGcWorkflowInput = {},
): Promise<CheckpointGcWorkflowOutput> {
  // Workflow ID pattern: CheckpointGc-platform-{date}
  // workflowId: `CheckpointGc-platform-${new Date().toISOString().slice(0,10)}`

  log.info('CheckpointGcWorkflow starting', { input });

  const checkpoints = await trimCheckpointsActivity({
    keepPerThread:   input.keepPerThread   ?? 10,
    keepRecentHours: input.keepRecentHours ?? 24,
  });
  log.info('checkpoints trimmed', checkpoints);

  // Must run AFTER trimCheckpointsActivity — drops orphan write rows.
  const checkpoint_writes = await trimCheckpointWritesActivity();
  log.info('checkpoint_writes trimmed', checkpoint_writes);

  const bot_turn_metrics = await trimMetricsActivity({
    retentionDays: input.metricsRetentionDays ?? 90,
  });
  log.info('bot_turn_metrics trimmed', bot_turn_metrics);

  log.info('CheckpointGcWorkflow done');
  return { checkpoints, checkpoint_writes, bot_turn_metrics };
}
