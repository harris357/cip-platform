// Slice 58C — generic lifecycle-state transition activity.
//
// Replaces the slice-58B-specific transitionToClassifyingActivity in
// the workflow's later phases. Validates with canTransition() before
// writing; idempotent on retry (returns early when the row is already
// in the target state).
//
// The activity also captures the optional preHitlState / prePurgeState
// columns when the target is hitl_admin_queue / soft_purged — these
// columns drive the resume path in slices 58D/58F/58G. Optional module
// + docType setters short-circuit a tiny race window where the classify
// result and the lifecycle move would otherwise be two separate
// transactions.

import { eq, sql } from 'drizzle-orm'

import { getDb } from '../../../db/index.js'
import { systemActorContext, withActorContext } from '../../../db/rls.js'
import { documents, auditEvents } from '../../../db/schema.js'
import { assertCanTransition, type LifecycleState } from '../../../lifecycle/states.js'

export interface TransitionLifecycleStateInput {
  tenantId:       string
  documentId:     string
  to:             LifecycleState
  /** Required when `to === 'hitl_admin_queue'`; populates documents.pre_hitl_state. */
  preHitlState?:  LifecycleState
  /** Required when `to === 'soft_purged'`  — slice 58G; populates pre_purge_state. */
  prePurgeState?: LifecycleState
  /** Free-form note recorded in audit_events.payload + state_reason column. */
  reason?:        string
  /** Optional metadata persisted in the same UPDATE for atomicity. */
  module?:        string
  docType?:       string
}

export async function transitionLifecycleStateActivity(
  input: TransitionLifecycleStateInput,
): Promise<void> {
  const { tenantId, documentId, to, preHitlState, prePurgeState, reason, module, docType } = input
  const db = getDb()

  await withActorContext(db, systemActorContext(tenantId), async (tx) => {
    const rows = await tx.select({ lifecycleState: documents.lifecycleState })
      .from(documents)
      .where(eq(documents.id, documentId))
    const current = rows[0]?.lifecycleState as LifecycleState | undefined
    if (!current) throw new Error(`transition-lifecycle-state: doc ${documentId} not found`)
    if (current === to) return                  // idempotent retry

    assertCanTransition(current, to)

    // Compose the update set. Drizzle types reject undefined fields, so
    // we build the object incrementally and apply it once.
    const setExpr: Record<string, unknown> = {
      lifecycleState: to,
      updatedAt:      sql`NOW()`,
    }
    if (reason !== undefined)        setExpr['stateReason']   = reason
    if (preHitlState !== undefined)  setExpr['preHitlState']  = preHitlState
    if (prePurgeState !== undefined) setExpr['prePurgeState'] = prePurgeState
    if (module !== undefined)        setExpr['module']        = module
    if (docType !== undefined)       setExpr['docType']       = docType

    await tx.update(documents).set(setExpr).where(eq(documents.id, documentId))

    await tx.insert(auditEvents).values({
      tenantId,
      documentId,
      actorRole: 'system',
      eventType: 'state_transition',
      payload: {
        from: current,
        to,
        ...(reason        !== undefined ? { reason }        : {}),
        ...(preHitlState  !== undefined ? { preHitlState }  : {}),
        ...(prePurgeState !== undefined ? { prePurgeState } : {}),
        ...(module        !== undefined ? { module }        : {}),
        ...(docType       !== undefined ? { docType }       : {}),
      },
    })
  })
}
