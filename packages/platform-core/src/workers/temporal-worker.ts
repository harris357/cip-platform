import { Worker } from '@temporalio/worker';
import { createTemporalWorkerConnection } from '@cip/shared/src/clients/temporal.js';
import * as activities from '../activities/index.js';

export async function startTemporalWorker(): Promise<void> {
  const connection = await createTemporalWorkerConnection();
  const namespace  = process.env['TEMPORAL_NAMESPACE']!;
  const taskQueue  = process.env['TEMPORAL_TASK_QUEUE_PLATFORM'] ?? 'cip-platform-tasks';

  const worker = await Worker.create({
    connection,
    namespace,
    taskQueue,
    workflowsPath: new URL('../workflows/index.js', import.meta.url).pathname,
    activities,
  });

  console.log(`Platform Temporal worker started — namespace: ${namespace}, queue: ${taskQueue}`);
  await worker.run();
}
