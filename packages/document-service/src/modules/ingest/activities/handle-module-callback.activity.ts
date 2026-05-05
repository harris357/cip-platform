// Slice 58E — applies the moduleCallback signal payload to the doc row.
//
// Called from the workflow once the `moduleCallback` signal fires
// (the downstream module workflow signals us when it has decided
// accepted/rejected). Persists the cross-reference fields and
// records an audit event. Idempotent on retry (last write wins).
//
// Output is Zod-parsed before return (Non-Negotiable #5).

import { eq, sql } from 'drizzle-orm'
import { z } from 'zod'

import { getDb } from '../../../db/index.js'
import { systemActorContext, withActorContext } from '../../../db/rls.js'
import { documents, auditEvents } from '../../../db/schema.js'

export const HandleModuleCallbackInputSchema = z.object({
  tenantId:             z.string().uuid(),
  documentId:           z.string().uuid(),
  moduleRecordId:       z.string(),
  downstreamWorkflowId: z.string(),
  workflowType:         z.string(),
  status:               z.enum(['accepted', 'rejected']),
  reason:               z.string().optional(),
})
export type HandleModuleCallbackInput = z.infer<typeof HandleModuleCallbackInputSchema>

export const HandleModuleCallbackOutputSchema = z.object({
  applied: z.literal(true),
})
export type HandleModuleCallbackOutput = z.infer<typeof HandleModuleCallbackOutputSchema>

export async function handleModuleCallbackActivity(
  input: HandleModuleCallbackInput,
): Promise<HandleModuleCallbackOutput> {
  const validated = HandleModuleCallbackInputSchema.parse(input)
  const db = getDb()

  await withActorContext(db, systemActorContext(validated.tenantId), async (tx) => {
    await tx.update(documents).set({
      downstreamModuleRecordId: validated.moduleRecordId,
      downstreamWorkflowId:     validated.downstreamWorkflowId,
      downstreamWorkflowType:   validated.workflowType,
      updatedAt:                sql`NOW()`,
    }).where(eq(documents.id, validated.documentId))

    await tx.insert(auditEvents).values({
      tenantId:   validated.tenantId,
      documentId: validated.documentId,
      actorRole:  'system',
      eventType:  'module_callback',
      payload: {
        moduleRecordId:        validated.moduleRecordId,
        downstreamWorkflowId:  validated.downstreamWorkflowId,
        workflowType:          validated.workflowType,
        status:                validated.status,
        ...(validated.reason !== undefined ? { reason: validated.reason } : {}),
      },
    })
  })

  return HandleModuleCallbackOutputSchema.parse({ applied: true })
}
