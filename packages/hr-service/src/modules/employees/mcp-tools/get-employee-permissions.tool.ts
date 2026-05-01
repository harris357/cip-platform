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
    'Return the CALLING user\'s own roles and effective permissions. ' +
    'Use when the user asks "what are my roles", "what permissions do I have", "what can I do" — questions about themselves. ' +
    'Scope: the caller only (never another employee). ' +
    'Audience: every authenticated employee (no permission gate; you can always see your own). ' +
    'Output: {roles[], permissions[]} (permissions are glob-expanded). ' +
    'Differs from employee_get (returns ANOTHER specific employee\'s detail, HR-only) and role_list (returns every role in the tenant, not the caller\'s assignments).',
    {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {
      requiredPermission: null,
      sideEffectLevel: 'read',
      whenToUse: [
        'User asks "what are my roles" / "what permissions do I have" / "what can I do"',
        'Caller wants to see their OWN access (not someone else\'s)',
      ],
      whenNotToUse: [
        'User is asking about another employee — use employee_get instead',
        'User wants the catalog of every role in the tenant — use role_list instead',
      ],
      commonNextTools: [],
      outputSchema: {
        type: 'object',
        required: ['data', 'message'],
        properties: {
          data: {
            type: 'object',
            required: ['roles', 'permissions'],
            properties: {
              roles:       { type: 'array', items: { type: 'string' } },
              permissions: { type: 'array', items: { type: 'string' } },
            },
          },
          message: { type: 'string' },
        },
      },
    } as any,
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
        // Render a user-facing message that lists the actual roles + permissions,
        // not just counts. The bot's card-renderer sends `message` directly to
        // Teams without LLM post-processing, so the summary needs to BE the
        // useful answer, not a stat.
        const rolesLine = roles.length > 0
          ? roles.map(r => `\`${r}\``).join(', ')
          : '_(none)_'
        const permsList = permissions.length > 0
          ? permissions.map(p => `\`${p}\``).join(', ')
          : '_(none)_'
        const userMessage =
          `You have **${roles.length}** role(s): ${rolesLine}\n\n` +
          `**${permissions.length}** permission(s): ${permsList}`
        const response: McpModuleResponse<{ permissions: string[]; roles: string[] }> = {
          data: { permissions, roles },
          message: userMessage,
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
