// Slice 58A — Temporal worker bootstrap.
//
// Intentionally a no-op in 58A: the SDK requires at least one of
// `activities` or `workflowsPath` to be non-empty, and the slice
// scope rule says no document-touching activities or workflows are
// allowed yet.  Booting an empty worker would crash:
//   "At least one task type must be enabled in `task_types`"
//
// 58B replaces this with the real worker that registers the ingest
// activities + DocumentProcessingWorkflow.

export async function startTemporalWorker(): Promise<void> {
  const namespace = process.env['TEMPORAL_NAMESPACE'] ?? '(unset)'
  const taskQueue = process.env['TEMPORAL_TASK_QUEUE_DOCUMENTS'] ?? 'cip-documents-tasks'
  console.log(
    `[temporal-worker] no-op in slice 58A (target namespace=${namespace} queue=${taskQueue}). ` +
    `58B will register the first activity and boot the worker.`,
  )
  // Resolve immediately; the caller in index.ts treats the worker as fire-and-forget.
}
