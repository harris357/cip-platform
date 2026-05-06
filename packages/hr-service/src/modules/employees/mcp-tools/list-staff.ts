import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { eq } from 'drizzle-orm'
import type { McpModuleResponse } from '@cip/shared'
import { getDb } from '../../../db/index.js'
import { withTenantRLS } from '../../../db/rls.js'
import { employees, users } from '../../../db/schema.js'
import { extractAuthContext } from '../../../mcp-server/auth.js'
import { buildStaffCard, type StaffCardRow } from './cards/staff-card.js'

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
    {
      requiredPermission: 'employee.list',
      sideEffectLevel: 'read',
      whenToUse: [
        'User wants a quick visual roster card in Teams',
      ],
      whenNotToUse: [
        'User needs raw paginated data — use employee_list',
        'Looking up one specific employee — use employee_find',
      ],
      commonNextTools: ['employee_find', 'employee_get'],
      outputSchema: {
        type: 'object',
        required: ['data'],
        properties: {
          data: { type: 'array' },
          card: {},
        },
      },
    } as any,
    async (_args, context) => {
      const { tenantId } = extractAuthContext(context.authInfo)
      const db = getDb()
      // Slice 65: identity moved to cip_platform.users — JOIN to read fullName/email.
      const staff = await withTenantRLS(db, tenantId, (tx) =>
        tx
          .select({
            id:             employees.id,
            employmentType: employees.employmentType,
            fullName:       users.fullName,
            email:          users.email,
          })
          .from(employees)
          .innerJoin(users, eq(users.id, employees.userId)),
      )
      const cardRows: StaffCardRow[] = staff.map(s => ({
        fullName:       s.fullName,
        email:          s.email,
        employmentType: s.employmentType,
      }))
      const response: McpModuleResponse<typeof staff> = {
        data: staff,
        card: buildStaffCard(cardRows),
        message: `${staff.length} employee(s) found.`,
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(response) }] }
    },
  )
}
