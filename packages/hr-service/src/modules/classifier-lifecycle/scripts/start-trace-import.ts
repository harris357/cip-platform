// Slice 57C: thin entrypoint for the trace-import K8s CronJob.
//
// Replaces the previous `python -m training.import_traces` invocation.
// Now starts RetrainModelWorkflow in 'import-only' mode — same workflow
// class, two schedules:
//   - Saturday 02:00 UTC (this trigger): mode='import-only' — ingest
//     new candidate rows for admin review, no train.
//   - Sunday 02:30 UTC (existing trainer-cronjob): full retrain cycle.
//
// One workflow definition, two K8s CronJobs feeding it. Eliminates the
// duplicate import logic between import_traces.py (cron) and
// importTracesActivity (workflow's first step).

import { createTemporalClient } from '@cip/shared';
import { RetrainModelWorkflow } from '../workflows/retrain-model.workflow.js';

async function main(): Promise<void> {
  const client = await createTemporalClient();

  const today = new Date().toISOString().slice(0, 10);
  // Workflow ID pattern: RetrainModel-{tenantId|'platform'}-{triggerId}
  const triggerId  = `cron-import-${today}`;
  const workflowId = `RetrainModel-platform-${triggerId}`;

  const handle = await client.workflow.start(RetrainModelWorkflow, {
    workflowId,
    taskQueue: process.env['TEMPORAL_TASK_QUEUE_HR'] ?? 'cip-hr-tasks',
    args: [{
      tenantId:  null,
      triggerId,
      mode:      'import-only',
    }],
    workflowIdReusePolicy: 'REJECT_DUPLICATE',
  });

  console.log(`[trace-import] started workflow=${workflowId} mode=import-only`);
  const result = await handle.result();
  console.log(`[trace-import] done`, result);
}

main().catch(err => {
  console.error(`[trace-import] FAILED: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});
