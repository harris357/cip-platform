// Slice 57B: thin entrypoint that the K8s CronJob runs to start the
// CheckpointGcWorkflow. Replaces the old `node dist/scripts/gc.js`
// invocation that did the work in-process — now it's a workflow.
//
// Why keep a K8s CronJob in front of the workflow (rather than a
// Temporal Schedule):
//   - Existing K8s CronJob template + secret mounts already work; no
//     new "schedule installer" Job needed at chart install time.
//   - Operators are familiar with K8s CronJob lifecycle.
//   - The CronJob is now a 1-line trigger; the durability lives in
//     Temporal Web UI just the same.
//
// A future slice can move the schedule itself into Temporal Schedules
// (so the K8s CronJob goes away entirely). v1 keeps both layers
// because we're conservative about cron migrations.

import { createTemporalClient } from '@cip/shared';
import { CheckpointGcWorkflow } from '../workflows/checkpoint-gc.workflow.js';

async function main(): Promise<void> {
  const client = await createTemporalClient();

  const today    = new Date().toISOString().slice(0, 10);
  const workflowId = `CheckpointGc-platform-${today}`;

  // Workflow ID pattern: CheckpointGc-platform-{date}
  const handle = await client.workflow.start(CheckpointGcWorkflow, {
    workflowId,
    taskQueue: process.env['TEMPORAL_TASK_QUEUE_HR'] ?? 'cip-hr-tasks',
    args: [{
      keepPerThread:        +(process.env['GC_KEEP_PER_THREAD']        ?? '10'),
      keepRecentHours:      +(process.env['GC_KEEP_RECENT_HOURS']      ?? '24'),
      metricsRetentionDays: +(process.env['GC_METRICS_RETENTION_DAYS'] ?? '90'),
    }],
    // Reuse-if-running: if yesterday's run somehow didn't complete and
    // is still running, don't pile a new one on. Default is REJECT_DUPLICATE.
    workflowIdReusePolicy: 'REJECT_DUPLICATE',
  });

  console.log(`[checkpoint-gc] started workflow=${workflowId}`);
  // Block until the workflow finishes — gives the CronJob a Pod-level
  // exit code that matches the workflow result. ops sees the right
  // status in `kubectl get jobs`.
  const result = await handle.result();
  console.log(`[checkpoint-gc] done`, result);
}

main().catch(err => {
  console.error(`[checkpoint-gc] FAILED: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});
