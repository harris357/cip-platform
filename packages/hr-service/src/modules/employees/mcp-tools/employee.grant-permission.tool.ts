import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { getPool } from '../../../db/index.js'
import { findEmployeeById } from '../../../db/queries/employees-extra.js'
import { findEmployeeByKeycloakId } from '../../../db/queries/employees.js'
import { grantRoleByCode } from '../../../db/queries/permissions.js'
import {
  assertPermission,
  extractAuthContext,
  PermissionDeniedError,
} from '../../../mcp-server/auth.js'
import { recordHrAction } from '../../../services/audit.js'
import { ok, refused } from './_envelope.js'

/**
 * Slice 38: HR-only. Grants a role (bundle of permissions) to an employee
 * by role code. Idempotent — duplicate grant is a no-op.
 *
 * The user-facing concept is "grant a permission"; the system grants the
 * role(s) that bundle that permission. Today the catalog is small enough
 * that we accept the role code directly. A future iteration may resolve
 * permission codes back to roles.
 */
export function registerEmployeeGrantPermission(server: McpServer): void {
  server.tool(
    'employee_grant_permission',
    'Grant a CIP role (which bundles permissions) to a specific employee. ' +
    'Scope: one employee, one role-by-code. ' +
    'Audience: HR + employee.grant_permission permission. ' +
    'Output: {employeeId, role} on success (idempotent — duplicate grant is a no-op). Side effect: audit row written. ' +
    'Required args: employeeId (UUID), role (CIP role code, e.g. "hr_standard", "hr-service-admin"). ' +
    'Use for "give Jane the HR admin role", "elevate". ' +
    'Differs from employee_assign_role (assigns Keycloak realm role like `hr` — not a CIP role) and employee_revoke_permission (the inverse).',
    {
      employeeId: z.string().uuid(),
      role:       z.string().min(1),
    },
    async (args, context) => {
      const ctx = extractAuthContext(context.authInfo)
      if (!ctx.roles.includes('hr')) {
        return refused('forbidden', 'employee_grant_permission requires the hr realm role')
      }
      try {
        await assertPermission(context.authInfo, 'employee.grant_permission')
      } catch (err) {
        if (err instanceof PermissionDeniedError) {
          return refused('permission_denied', err.message)
        }
        throw err
      }

      const pool = getPool()
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [ctx.tenantId])

        const actor = await findEmployeeByKeycloakId(client, ctx.tenantId, ctx.employeeId)
        if (!actor) {
          await client.query('ROLLBACK')
          return refused('actor_not_provisioned', 'caller is not an employee in this tenant')
        }

        const target = await findEmployeeById(client, ctx.tenantId, args.employeeId)
        if (!target) {
          await client.query('ROLLBACK')
          await recordHrAction({
            tenantId: ctx.tenantId, actorEmployeeId: actor.id,
            actionType: 'employee.grant_permission', targetEmployeeId: args.employeeId,
            payload: { role: args.role },
            result: 'failed', errorCode: 'not_found', errorMessage: 'employee not found',
          })
          return refused('not_found', `employee ${args.employeeId} not found`)
        }

        // Slice 42C: existence check now hits the new roles table.
        // grantRoleByCode (proxy to assignRoleToEmployee) inserts into
        // employee_role_assignments which references roles, so the role
        // must actually exist for the assignment to land.
        const roleCheck = await client.query<{ id: string }>(
          `SELECT id FROM roles WHERE tenant_id = $1 AND code = $2 LIMIT 1`,
          [ctx.tenantId, args.role],
        )
        if (roleCheck.rows.length === 0) {
          await client.query('ROLLBACK')
          await recordHrAction({
            tenantId: ctx.tenantId, actorEmployeeId: actor.id,
            actionType: 'employee.grant_permission', targetEmployeeId: args.employeeId,
            payload: { role: args.role },
            result: 'failed', errorCode: 'unknown_role', errorMessage: `role '${args.role}' not in tenant catalog`,
          })
          return refused('unknown_role', `role '${args.role}' is not defined for this tenant`)
        }

        await grantRoleByCode(client, ctx.tenantId, args.employeeId, args.role, actor.id)
        await client.query('COMMIT')

        await recordHrAction({
          tenantId: ctx.tenantId, actorEmployeeId: actor.id,
          actionType: 'employee.grant_permission', targetEmployeeId: args.employeeId,
          payload: { role: args.role }, result: 'success',
        })
        return ok(
          { employeeId: args.employeeId, role: args.role },
          `Role '${args.role}' granted.`,
        )
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined)
        return refused('internal', err instanceof Error ? err.message : String(err))
      } finally {
        client.release()
      }
    },
  )
}
