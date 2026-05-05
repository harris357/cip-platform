// Slice 58A — lifecycle state machine.  Mirrors the CHECK constraint
// in 002_documents_table.sql exactly.  Adding a state means updating:
//   1. this enum
//   2. the CHECK in 002_documents_table.sql
//   3. the access matrix in src/lifecycle/access-policy.ts
//   4. the RLS policy in 006_rls_policies.sql
//
// The state machine is enforced in app code (transitionStateActivity
// in 58B+).  Database-level constraints only enforce membership in
// the valid set, not transition legality.

export const LIFECYCLE_STATES = [
  'quarantined',
  'scanning',
  'scan_failed',
  'classifying',
  'awaiting_subject',
  'awaiting_routing',
  'hitl_admin_queue',
  'reclassification_requested',
  'routed',
  'archived',
  'soft_purged',
  'hard_purged',
  'failed',
] as const
export type LifecycleState = (typeof LIFECYCLE_STATES)[number]

/**
 * Allowed forward transitions from each state.  The phase-loop
 * workflow in 58B treats this as authoritative; transitionStateActivity
 * rejects anything not in this map.
 *
 * Reverse transitions exist for reclassification (any → 'classifying'
 * via 58F) and restoration from soft_purge (any → pre_purge_state via
 * 58G).  Those are special-cased — clearForReclassificationActivity
 * and restoreDocumentActivity bypass this map's checks because
 * they're explicit recovery paths, not natural workflow transitions.
 */
export const VALID_TRANSITIONS: Record<LifecycleState, readonly LifecycleState[]> = {
  quarantined:                ['scanning', 'failed', 'soft_purged'],
  scanning:                   ['classifying', 'scan_failed', 'failed', 'soft_purged'],
  scan_failed:                ['failed', 'soft_purged'],
  classifying:                ['awaiting_subject', 'hitl_admin_queue', 'failed', 'soft_purged'],
  awaiting_subject:           ['awaiting_routing', 'hitl_admin_queue', 'failed', 'soft_purged'],
  awaiting_routing:           ['routed', 'hitl_admin_queue', 'failed', 'soft_purged'],
  hitl_admin_queue:           ['classifying', 'awaiting_subject', 'awaiting_routing', 'routed', 'failed', 'soft_purged'],
  reclassification_requested: ['classifying', 'archived', 'failed', 'soft_purged'],
  routed:                     ['archived', 'reclassification_requested', 'failed', 'soft_purged'],
  archived:                   ['reclassification_requested', 'soft_purged'],
  soft_purged:                ['hard_purged', 'quarantined', 'scanning', 'scan_failed',
                               'classifying', 'awaiting_subject', 'awaiting_routing',
                               'hitl_admin_queue', 'routed', 'archived', 'failed'], // restore can return to any prior state
  hard_purged:                [], // terminal
  failed:                     ['soft_purged'],
} as const

export function canTransition(from: LifecycleState, to: LifecycleState): boolean {
  return VALID_TRANSITIONS[from].includes(to)
}

export function assertCanTransition(from: LifecycleState, to: LifecycleState): void {
  if (!canTransition(from, to)) {
    throw new Error(`illegal lifecycle transition: ${from} → ${to}`)
  }
}

/**
 * Active phases — the workflow is doing work or waiting on a signal.
 * Used by 58G's restore: if pre_purge_state is one of these, the
 * restore activity restarts a workflow at that phase.
 */
export const ACTIVE_PHASES: ReadonlySet<LifecycleState> = new Set<LifecycleState>([
  'quarantined',
  'scanning',
  'classifying',
  'awaiting_subject',
  'awaiting_routing',
  'hitl_admin_queue',
  'reclassification_requested',
  'routed', // routed is "module workflow in flight, awaiting callback" — workflow IS active
])

/** Terminal phases — no further transitions naturally happen. */
export const TERMINAL_PHASES: ReadonlySet<LifecycleState> = new Set<LifecycleState>([
  'archived',
  'hard_purged',
  'failed',
])
