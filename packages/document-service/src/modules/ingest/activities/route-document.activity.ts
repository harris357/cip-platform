// Slice 58E — routing-map resolver activity.
//
// Reads the (tenantId, module, doc_type) row from
// `cip_documents.document_routing_map` using the same four-tier
// fallback as the extraction registry:
//   1. (tenant_id, module, doc_type)
//   2. (tenant_id, module, '*')
//   3. (zero-UUID, module, doc_type)
//   4. (zero-UUID, module, '*')
//
// Returns `{ matched: false }` when no enabled row matches; the
// workflow then parks the doc in `hitl_admin_queue` with reason
// 'no_routing_rule' and waits for the admin tools to either route
// (signal) or reject.
//
// Output is Zod-parsed before return (Non-Negotiable #5).

import { z } from 'zod'

import { getPool } from '../../../db/index.js'

const GLOBAL_SENTINEL = '00000000-0000-0000-0000-000000000000'

export const RouteDocumentInputSchema = z.object({
  tenantId:   z.string().uuid(),
  documentId: z.string().uuid(),
  module:     z.string(),
  docType:    z.string(),
})
export type RouteDocumentInput = z.infer<typeof RouteDocumentInputSchema>

export const RouteDocumentOutputSchema = z.discriminatedUnion('matched', [
  z.object({
    matched:      z.literal(true),
    taskQueue:    z.string(),
    workflowType: z.string(),
    /** Echoed back so the workflow can audit which rule matched. */
    matchedTenantId: z.string().uuid(),
    matchedModule:   z.string(),
    matchedDocType:  z.string(),
  }),
  z.object({
    matched: z.literal(false),
  }),
])
export type RouteDocumentOutput = z.infer<typeof RouteDocumentOutputSchema>

interface RoutingRow {
  tenant_id:     string
  module:        string
  doc_type:      string
  task_queue:    string
  workflow_type: string
  enabled:       boolean
}

export async function routeDocumentActivity(
  input: RouteDocumentInput,
): Promise<RouteDocumentOutput> {
  const validated = RouteDocumentInputSchema.parse(input)
  const pool = getPool()

  const result = await pool.query<RoutingRow>(
    `SELECT tenant_id, module, doc_type, task_queue, workflow_type, enabled
       FROM cip_documents.document_routing_map
      WHERE module = $2
        AND (tenant_id = $1 OR tenant_id = $4::uuid)
        AND (doc_type = $3 OR doc_type = '*')`,
    [validated.tenantId, validated.module, validated.docType, GLOBAL_SENTINEL],
  )

  // Specificity: tenant_id-specific > zero-UUID; exact doc_type > '*'.
  // Same scoring shape as extraction registry — bump weights so tier
  // ordering is preserved when choosing among enabled rows.
  const score = (r: RoutingRow): number =>
    (r.tenant_id === validated.tenantId ? 2 : 0)
    + (r.doc_type === validated.docType ? 1 : 0)

  const candidates = result.rows
    .filter((r): r is RoutingRow => r.enabled)
    .sort((a, b) => score(b) - score(a))

  const top = candidates[0]
  if (!top) {
    return RouteDocumentOutputSchema.parse({ matched: false })
  }

  return RouteDocumentOutputSchema.parse({
    matched:         true,
    taskQueue:       top.task_queue,
    workflowType:    top.workflow_type,
    matchedTenantId: top.tenant_id,
    matchedModule:   top.module,
    matchedDocType:  top.doc_type,
  })
}
