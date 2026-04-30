import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { McpModuleResponse } from '@cip/shared'
import { getPool } from '../../../db/index.js'
import { findEmployeeByKeycloakId } from '../../../db/queries/employees.js'
import {
  getPermissionsForEmployee,
  getRoleCodesForEmployee,
} from '../../../db/queries/permissions.js'
import { extractAuthContext } from '../../../mcp-server/auth.js'

/**
 * Slice 38: replaces get_employee_capabilities. Returns the calling
 * employee's deduped permission codes plus the role codes attached.
 *
 * Auth: every authenticated user; no permission gate (callers read their own).
 * Used by the bot's resolveAuthContext on every turn.
 */
export function registerGetEmployeePermissions(server: McpServer): void {
  server.tool(
    'get_employee_permissions',
    'Returns the calling employee\'s permission codes and role codes',
    {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {} as any,
    async (_args, context) => {
      const ctx = extractAuthContext(context.authInfo)
      const pool = getPool()
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [ctx.tenantId])
        const employee = await findEmployeeByKeycloakId(client, ctx.tenantId, ctx.employeeId)
        if (!employee) {
          await client.query('COMMIT')
          const empty: McpModuleResponse<{ permissions: string[]; roles: string[] }> = {
            data: { permissions: [], roles: [] },
            message: 'Caller is not provisioned in this tenant.',
          }
          return { content: [{ type: 'text' as const, text: JSON.stringify(empty) }] }
        }
        const [permissions, roles] = await Promise.all([
          getPermissionsForEmployee(client, employee.id),
          getRoleCodesForEmployee(client, employee.id),
        ])
        await client.query('COMMIT')
        const response: McpModuleResponse<{ permissions: string[]; roles: string[] }> = {
          data: { permissions, roles },
          message: `${roles.length} role(s), ${permissions.length} permission(s).`,
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify(response) }] }
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw err
      } finally {
        client.release()
      }
    },
  )
}
