// Slice 58E — final persistence step before lifecycle → 'archived'.
//
// Called from the workflow's `awaiting_module_callback` exit branch.
// `handle-module-callback` already wrote the cross-reference; this
// activity is the seam where any module-agnostic finalisation can
// happen (e.g. emit a 'module_completed' audit event distinct from
// 'module_callback'). Idempotent on retry — only writes the audit
// event, no UPDATE of the documents row.
//
// Output is Zod-parsed before return (Non-Negotiable #5).

import { z } from 'zod'

import { getDb } from '../../../db/index.js'
import { systemActorContext, withActorContext } from '../../../db/rls.js'
import { auditEvents } from '../../../db/schema.js'

export const PersistDownstreamRecordInputSchema = z.object({
  tenantId:       z.string().uuid(),
  documentId:     z.string().uuid(),
  moduleRecordId: z.string(),
  status:         z.enum(['accepted', 'rejected']),
})
export type PersistDownstreamRecordInput = z.infer<typeof PersistDownstreamRecordInputSchema>

export const PersistDownstreamRecordOutputSchema = z.object({
  persisted: z.literal(true),
})
export type PersistDownstreamRecordOutput = z.infer<typeof PersistDownstreamRecordOutputSchema>

export async function persistDownstreamRecordActivity(
  input: PersistDownstreamRecordInput,
): Promise<PersistDownstreamRecordOutput> {
  const validated = PersistDownstreamRecordInputSchema.parse(input)
  const db = getDb()

  await withActorContext(db, systemActorContext(validated.tenantId), async (tx) => {
    await tx.insert(auditEvents).values({
      tenantId:   validated.tenantId,
      documentId: validated.documentId,
      actorRole:  'system',
      eventType:  'module_completed',
      payload: {
        moduleRecordId: validated.moduleRecordId,
        status:         validated.status,
      },
    })
  })

  return PersistDownstreamRecordOutputSchema.parse({ persisted: true })
}
