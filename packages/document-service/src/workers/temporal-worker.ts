// Slice 58B — Temporal worker bootstrap.
//
// Replaces 58A's no-op. Boots a single worker that consumes the
// `cip-documents-tasks` queue, registering every activity exported
// from `modules/ingest/activities` and the workflow bundle compiled
// from `modules/ingest/workflows`.

import { NativeConnection, Worker } from '@temporalio/worker'

import * as ingestActivities from '../modules/ingest/activities/index.js'

export async function startTemporalWorker(): Promise<void> {
  const address   = process.env['TEMPORAL_ADDRESS']
  const namespace = process.env['TEMPORAL_NAMESPACE']
  const apiKey    = process.env['TEMPORAL_API_KEY']
  const taskQueue = process.env['TEMPORAL_TASK_QUEUE_DOCUMENTS'] ?? 'cip-documents-tasks'

  if (!address || !namespace || !apiKey) {
    throw new Error('Temporal worker: TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE, TEMPORAL_API_KEY all required')
  }

  // Use the API-key flavour identical to hr-service. tls=true is
  // mandatory for Temporal Cloud / managed namespace.
  const connection = await NativeConnection.connect({
    address,
    tls: true,
    metadata: { authorization: `Bearer ${apiKey}` },
  })

  const worker = await Worker.create({
    connection,
    namespace,
    workflowsPath: new URL('../modules/ingest/workflows/index.js', import.meta.url).pathname,
    activities: { ...ingestActivities },
    taskQueue,
  })

  console.log(`[temporal-worker] document-service worker starting (queue=${taskQueue}, namespace=${namespace})`)
  await worker.run()
}
