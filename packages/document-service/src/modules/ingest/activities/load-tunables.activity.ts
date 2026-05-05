// Slice 58C — workflow-callable wrapper around loadDocumentsTunables.
//
// Workflow code can't make DB calls; this thin activity exposes the
// merged per-tenant tunables to the phase loop so it can apply
// thresholds (classifier confidence, etc.) without re-rolling the
// tunable-merge logic on the workflow side.

import { loadDocumentsTunables, type DocumentsTunables } from '../../../sensitivity/tunables.js'

export interface LoadDocumentsTunablesInput {
  tenantId: string
}

export async function loadDocumentsTunablesActivity(
  input: LoadDocumentsTunablesInput,
): Promise<DocumentsTunables> {
  return loadDocumentsTunables(input.tenantId)
}
