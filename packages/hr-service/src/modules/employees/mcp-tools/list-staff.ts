import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { McpModuleResponse } from '@cip/shared'
import { getDb } from '../../../db/index.js'
import { withTenantRLS } from '../../../db/rls.js'
import { employees } from '../../../db/schema.js'
import { extractAuthContext } from '../../../mcp-server/auth.js'
import { buildStaffCard } from './cards/staff-card.js'

type EmployeeRow = typeof employees.$inferSelect

export function registerListStaff(server: McpServer): void {
  server.tool(
    'list_staff',
    'List all employees in the tenant in card form (Adaptive Card output for Teams). ' +
    'Scope: tenant-wide. ' +
    'Audience: anyone with `employee.list` permission. ' +
    'Output: {data: employees[], card: AdaptiveCard, message}. ' +
    'Use when the user wants a quick visual roster — Teams renders the adaptive card. ' +
    'Differs from employee_list (paginated raw data with filters, no card) and employee_find (single employee by exact email).',
    {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { requiredPermission: 'employee.list' } as any,
    async (_args, context) => {
      const { tenantId } = extractAuthContext(context.authInfo)
      const db = getDb()
      const staff = await withTenantRLS(db, tenantId, (tx) =>
        tx.select().from(employees),
      )
      const response: McpModuleResponse<EmployeeRow[]> = {
        data: staff,
        card: buildStaffCard(staff),
        message: `${staff.length} employee(s) found.`,
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(response) }] }
    },
  )
}
