// Slice 58A — access policy composition rule.
//
// Mirror of the SQL policy in 006_rls_policies.sql.  Provides the same
// answer in TypeScript so app code can pre-flight a permission check
// without round-tripping the DB.  The DB-side policy is the
// enforcement point; this is the predict-and-explain helper.
//
// If you change one, change the other.  The unit tests in
// test/access-policy.test.ts pin the matrix.

import type { LifecycleState } from './states.js'
import type { ActorContext } from '../db/rls.js'

export interface PolicyDoc {
  uploaderEmployeeId: string | null
  subjectEmployeeId:  string | null
  module:             string | null
  lifecycleState:     LifecycleState
}

export interface PolicyDecision {
  allowed: boolean
  reason:  string
}

const ALLOW = (reason: string): PolicyDecision => ({ allowed: true, reason })
const DENY  = (reason: string): PolicyDecision => ({ allowed: false, reason })

/**
 * Returns whether `actor` is allowed to read `doc` and the reasoning
 * string (useful for debug logs and audit_events).  Does NOT check
 * tenant — assumes the caller has already filtered by tenant_id (RLS
 * tenant policy + app-level filter).
 */
export function canRead(actor: ActorContext, doc: PolicyDoc): PolicyDecision {
  // 1. 'system' bypass — Temporal activities, cron workflows, internal callbacks
  if (actor.actorRole === 'system') return ALLOW('system')

  // 2. hard_purged: terminal, bytes gone — nobody but system reads
  if (doc.lifecycleState === 'hard_purged') return DENY('hard_purged')

  // 3. soft_purged: gated on documents.admin.unpurge specifically (NOT
  //    documents.admin.read).  Even uploader cannot read once soft-purged
  //    (the doc is administratively hidden until restored).
  if (doc.lifecycleState === 'soft_purged') {
    return actor.hasDocumentsAdminUnpurge
      ? ALLOW('documents_admin_unpurge')
      : DENY('soft_purged_unpurge_only')
  }

  // 4. Uploader sees own — any non-purged state
  if (
    doc.uploaderEmployeeId &&
    doc.uploaderEmployeeId === actor.employeeId
  ) {
    return ALLOW('uploader_own')
  }

  // 5. Post-routing (routed/archived): doc-service admin LOSES forensic
  //    access (modules own ACL).  Only subject + module-permitted
  //    readers, plus uploader (handled above).
  if (doc.lifecycleState === 'routed' || doc.lifecycleState === 'archived') {
    if (doc.subjectEmployeeId && doc.subjectEmployeeId === actor.employeeId) {
      return ALLOW('subject_self')
    }
    if (doc.module && actor.modulePermissionsByModule[doc.module] === true) {
      return ALLOW(`module_read:${doc.module}`)
    }
    return DENY('post_routing_no_module_access')
  }

  // 6. Pre-classification states (quarantined/scanning/scan_failed/
  //    classifying/awaiting_subject/awaiting_routing/failed) +
  //    HITL queue + reclassification queue: doc-service admin can read
  //    for forensic / triage.
  if (actor.hasDocumentsAdminRead) return ALLOW('documents_admin_read')

  return DENY('pre_classification_uploader_or_admin_only')
}
