import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { getPool } from '../../../db/index.js'
import { findEmployeeById } from '../../../db/queries/employees-extra.js'
import { findEmployeeByKeycloakId } from '../../../db/queries/employees.js'
import {
  countRolesForEmployee,
  revokeRoleByCode,
} from '../../../db/queries/permissions.js'
import {
  assertPermission,
  extractAuthContext,
  PermissionDeniedError,
} from '../../../mcp-server/auth.js'
import { recordHrAction } from '../../../services/audit.js'
import { ok, refused } from './_envelope.js'

/**
 * Slice 38: HR-only. Revokes a role (bundle of permissions) from an employee
 * by role code. Idempotent — silently no-ops if the row didn't exist.
 *
 * Refuses to leave the employee with zero roles — that would orphan them
 * from the platform with no permissions and no UI affordance to recover.
 * Use employee.disable for "remove this person from access entirely".
 */
export function registerEmployeeRevokePermission(server: McpServer): void {
  server.tool(
    'employee_revoke_permission',
    'Revoke a CIP role from a specific employee. ' +
    'Scope: one employee, one role-by-code. ' +
    'Audience: HR + employee.revoke_permission permission. ' +
    'Output: {employeeId, role} on success (idempotent — no-op if not currently held). Refuses if it would leave the employee with zero roles — use employee_disable for full off-board. ' +
    'Required args: employeeId (UUID), role (CIP role code). ' +
    'Use for "remove HR admin role from Jane". ' +
    'Differs from employee_revoke_role (Keycloak realm role) and employee_disable (full off-board).',
    {
      employeeId: z.string().uuid(),
      role:       z.string().min(1),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { requiredPermission: 'employee.revoke_permission' } as any,
    async (args, context) => {
      const ctx = extractAuthContext(context.authInfo)
      if (!ctx.roles.includes('hr')) {
        return refused('forbidden', 'employee_revoke_permission requires the hr realm role')
      }
      try {
        await assertPermission(context.authInfo, 'employee.revoke_permission')
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
            actionType: 'employee.revoke_permission', targetEmployeeId: args.employeeId,
            payload: { role: args.role },
            result: 'failed', errorCode: 'not_found', errorMessage: 'employee not found',
          })
          return refused('not_found', `employee ${args.employeeId} not found`)
        }

        const roleCount = await countRolesForEmployee(client, args.employeeId)
        if (roleCount <= 1) {
          await client.query('ROLLBACK')
          await recordHrAction({
            tenantId: ctx.tenantId, actorEmployeeId: actor.id,
            actionType: 'employee.revoke_permission', targetEmployeeId: args.employeeId,
            payload: { role: args.role, roleCount },
            result: 'failed', errorCode: 'would_orphan',
            errorMessage: 'revoke would leave employee with zero roles',
          })
          return refused(
            'would_orphan',
            'Cannot revoke the employee\'s only remaining role. Use employee_disable instead.',
          )
        }

        await revokeRoleByCode(client, ctx.tenantId, args.employeeId, args.role)
        await client.query('COMMIT')

        await recordHrAction({
          tenantId: ctx.tenantId, actorEmployeeId: actor.id,
          actionType: 'employee.revoke_permission', targetEmployeeId: args.employeeId,
          payload: { role: args.role }, result: 'success',
        })
        return ok(
          { employeeId: args.employeeId, role: args.role },
          `Role '${args.role}' revoked.`,
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
