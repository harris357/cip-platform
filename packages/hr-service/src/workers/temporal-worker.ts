import { Worker } from '@temporalio/worker';
import { createTemporalWorkerConnection } from '@cip/shared';
import * as certActivities from '../modules/certifications/activities/index.js';
import * as employeeActivities from '../modules/employees/activities/index.js';

export async function startTemporalWorker(): Promise<void> {
  const connection = await createTemporalWorkerConnection();
  // Dev: TEMPORAL_NAMESPACE is a single shared namespace (e.g. "cip-dev").
  // Prod: each tenant gets its own namespace "${tenantId}.cip", created by
  //       platform-core TenantProvisioningWorkflow → createTemporalNamespace.
  //       Deploy-time helm --set env.TEMPORAL_NAMESPACE="${tenantId}.cip" per worker replica.
  const namespace  = process.env['TEMPORAL_NAMESPACE']!;

  const worker = await Worker.create({
    connection,
    namespace,
    workflowsPath: new URL('../workflows/index.js', import.meta.url).pathname,
    activities: { ...certActivities, ...employeeActivities },
    taskQueue: process.env['TEMPORAL_TASK_QUEUE_HR'] ?? 'cip-hr-tasks',
  });

  await worker.run();
}
