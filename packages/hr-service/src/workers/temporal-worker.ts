import { Worker } from '@temporalio/worker';
import { createTemporalWorkerConnection } from '@cip/shared/src/clients/temporal.js';
import * as activities from '../activities/index.js';

/**
 * Starts a Temporal worker for the HR domain.
 * The worker registers against the tenant namespace from env.
 * In production, one worker pod serves multiple tenant namespaces
 * by reading them from config and creating multiple Worker instances.
 */
export async function startTemporalWorker(): Promise<void> {
  const connection = await createTemporalWorkerConnection();
  const namespace  = process.env['TEMPORAL_NAMESPACE']!;
  const taskQueue  = process.env['TEMPORAL_TASK_QUEUE'] ?? 'cip-hr-tasks';

  const worker = await Worker.create({
    connection,
    namespace,
    taskQueue,
    workflowsPath: new URL('../workflows/index.js', import.meta.url).pathname,
    activities,
  });

  console.log(`HR Temporal worker started — namespace: ${namespace}, queue: ${taskQueue}`);
  await worker.run();
}
