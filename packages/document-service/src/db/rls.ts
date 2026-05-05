import { sql } from 'drizzle-orm'
import type { Db } from './index.js'

/**
 * Actor context resolved from the JWT plus permission catalog.  Every
 * field maps to a session GUC that the RLS policy in 006_rls_policies.sql
 * reads.  Don't bypass this — direct DB calls without setting these
 * GUCs will return zero rows from any policy-protected SELECT.
 */
export interface ActorContext {
  tenantId:    string
  employeeId:  string
  /** 'system' bypasses the lifecycle gate; 'admin'/'uploader'/'reader' use it. */
  actorRole:   'system' | 'uploader' | 'admin' | 'subject' | 'module' | 'reader'
  hasDocumentsAdminRead:    boolean
  hasDocumentsAdminUnpurge: boolean
  hasDocumentsAuditRead:    boolean
  /**
   * Map of module → bool: did the actor's permission set include
   * `${module}.read`?  Drives the post-routing access clause via
   * the dynamic GUC `app.has_module_read_for_${module}`.  Module
   * names come from our catalog (cert/training/...), never from
   * untrusted input — but we still allow-list characters for
   * defense in depth.
   */
  modulePermissionsByModule: Record<string, boolean>
}

const MODULE_NAME_RE = /^[a-z][a-z0-9_]{0,31}$/

/** Set GUCs and run fn inside a transaction with the actor context active. */
export async function withActorContext<T>(
  db: Db,
  actor: ActorContext,
  fn: (tx: Db) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    // set_config(key, value, is_local=true) is the parameterised equivalent
    // of SET LOCAL — the latter does NOT accept bind parameters.
    await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${actor.tenantId}, true)`)
    await tx.execute(sql`SELECT set_config('app.current_employee_id', ${actor.employeeId}, true)`)
    await tx.execute(sql`SELECT set_config('app.actor_role', ${actor.actorRole}, true)`)
    await tx.execute(sql`SELECT set_config('app.has_documents_admin_read',    ${String(actor.hasDocumentsAdminRead)},    true)`)
    await tx.execute(sql`SELECT set_config('app.has_documents_admin_unpurge', ${String(actor.hasDocumentsAdminUnpurge)}, true)`)
    await tx.execute(sql`SELECT set_config('app.has_documents_audit_read',    ${String(actor.hasDocumentsAuditRead)},    true)`)

    for (const [mod, has] of Object.entries(actor.modulePermissionsByModule)) {
      if (!MODULE_NAME_RE.test(mod)) {
        throw new Error(`refusing to set GUC for unsafe module name: ${JSON.stringify(mod)}`)
      }
      // GUC name is dynamic (`app.has_module_read_for_${mod}`); set_config takes
      // the name as a parameter so we don't need raw SQL interpolation.
      await tx.execute(sql`SELECT set_config(${'app.has_module_read_for_' + mod}, ${String(has)}, true)`)
    }

    return fn(tx as unknown as Db)
  })
}

/**
 * System-actor context for internal code paths (Temporal activities,
 * cron workflows, etc.) that need to operate across documents
 * regardless of human permission state.  Use sparingly; prefer
 * actor-scoped context when an actor identity is available.
 */
export function systemActorContext(tenantId: string, systemEmployeeId = '00000000-0000-0000-0000-000000000000'): ActorContext {
  return {
    tenantId,
    employeeId: systemEmployeeId,
    actorRole: 'system',
    hasDocumentsAdminRead: false,
    hasDocumentsAdminUnpurge: false,
    hasDocumentsAuditRead: false,
    modulePermissionsByModule: {},
  }
}
