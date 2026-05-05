// Slice 58B — workflow registry. Imported by the worker via
// `workflowsPath` (Temporal compiles the bundle on worker boot).
//
// New workflows for the ingest module land here. Subject + route +
// reclassify workflows are owned by slices 58D/58E/58F respectively.

export {
  DocumentProcessingWorkflow,
  reclassifySignal,
} from './document-processing.workflow.js'
export type {
  DocumentProcessingInput,
  DocumentPhase,
  ReclassifyPayload,
} from './document-processing.workflow.js'
