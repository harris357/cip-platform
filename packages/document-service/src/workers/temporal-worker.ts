// Slice 58A — Temporal worker bootstrap.  Connects to the cluster's
// shared namespace and registers no activities yet (slice scope rule:
// 58A creates no document-touching code).  58B+ adds the ingest
// activities and `DocumentProcessingWorkflow`.

import { Worker } from '@temporalio/worker'
import { createTemporalWorkerConnection } from '@cip/shared'

export async function startTemporalWorker(): Promise<void> {
  const connection = await createTemporalWorkerConnection()
  const namespace  = process.env['TEMPORAL_NAMESPACE']!
  const taskQueue  = process.env['TEMPORAL_TASK_QUEUE_DOCUMENTS'] ?? 'cip-documents-tasks'

  // No activities, no workflowsPath in 58A — Worker.create requires at
  // least one of activities OR workflowsPath, so we register an empty
  // activities object.  58B replaces this.
  const worker = await Worker.create({
    connection,
    namespace,
    taskQueue,
    activities: {},
  })

  console.log(`[temporal-worker] starting on namespace=${namespace} queue=${taskQueue}`)
  await worker.run()
}
