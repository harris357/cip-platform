// Slice 58B — single-row state transition activity.
//
// Workflow files can't directly call DB SDKs; this thin activity wraps
// the SQL UPDATE that flips lifecycle_state from 'scanning' (or its
// post-sensitivity equivalent) to 'classifying'. 58C may replace it
// with a generic transition_state activity that takes a target state;
// for 58B we only need this one transition so the activity is named
// after its specific job.

import { eq, sql } from 'drizzle-orm'

import { getDb } from '../../../db/index.js'
import { systemActorContext, withActorContext } from '../../../db/rls.js'
import { documents, auditEvents } from '../../../db/schema.js'
import { assertCanTransition, type LifecycleState } from '../../../lifecycle/states.js'

export interface TransitionToClassifyingInput {
  tenantId:   string
  documentId: string
}

export async function transitionToClassifyingActivity(
  input: TransitionToClassifyingInput,
): Promise<void> {
  const { tenantId, documentId } = input
  const db = getDb()

  await withActorContext(db, systemActorContext(tenantId), async (tx) => {
    const rows = await tx.select({ lifecycleState: documents.lifecycleState })
      .from(documents)
      .where(eq(documents.id, documentId))
    const current = rows[0]?.lifecycleState as LifecycleState | undefined
    if (!current) throw new Error(`transition-to-classifying: doc ${documentId} not found`)
    if (current === 'classifying') return       // idempotent retry — already there
    assertCanTransition(current, 'classifying')

    await tx.update(documents).set({
      lifecycleState: 'classifying',
      updatedAt:      sql`NOW()`,
    }).where(eq(documents.id, documentId))

    await tx.insert(auditEvents).values({
      tenantId,
      documentId,
      actorRole: 'system',
      eventType: 'state_transition',
      payload:   { from: current, to: 'classifying' },
    })
  })
}
