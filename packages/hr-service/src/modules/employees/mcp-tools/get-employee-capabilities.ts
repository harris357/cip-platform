import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { eq } from 'drizzle-orm'
import type { McpModuleResponse } from '@cip/shared'
import { getDb } from '../../../db/index.js'
import { withTenantRLS } from '../../../db/rls.js'
import { employeeRoles, roles } from '../../../db/schema.js'
import { extractAuthContext } from '../../../mcp-server/auth.js'

export type RoleCapabilities = Record<string, boolean>

function mergeCapabilities(caps: RoleCapabilities[]): RoleCapabilities {
  return caps.reduce<RoleCapabilities>((acc, cap) => ({ ...acc, ...cap }), {})
}

export function registerGetEmployeeCapabilities(server: McpServer): void {
  server.tool(
    'get_employee_capabilities',
    "Returns the calling employee's merged RoleCapabilities across all assigned roles",
    {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { requiredCapability: '' } as any,
    async (_args, context) => {
      const { tenantId, employeeId } = extractAuthContext(context.authInfo)
      const db = getDb()

      const roleRows = await withTenantRLS(db, tenantId, (tx) =>
        tx
          .select({
            keycloakRole: roles.keycloakRole,
            capabilities: roles.capabilities,
          })
          .from(employeeRoles)
          .innerJoin(roles, eq(employeeRoles.roleId, roles.id))
          .where(eq(employeeRoles.employeeId, employeeId)),
      )

      const capabilities = mergeCapabilities(
        roleRows.map((r) => r.capabilities as RoleCapabilities),
      )
      const roleNames = roleRows.map((r) => r.keycloakRole)

      const response: McpModuleResponse<{ capabilities: RoleCapabilities; roles: string[] }> = {
        data: { capabilities, roles: roleNames },
        message: `${roleNames.length} role(s) active.`,
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(response) }] }
    },
  )
}
