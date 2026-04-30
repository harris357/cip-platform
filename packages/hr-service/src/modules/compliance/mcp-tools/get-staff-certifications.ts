import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import type { McpModuleResponse } from '@cip/shared'
import { getDb } from '../../../db/index.js'
import { withTenantRLS } from '../../../db/rls.js'
import { certifications, certificateDefinitions } from '../../../db/schema.js'
import { extractAuthContext } from '../../../mcp-server/auth.js'
import { buildStaffCertsCard, type StaffCertReport } from './cards/staff-certs-card.js'

export function registerGetStaffCertifications(server: McpServer): void {
  server.tool(
    'get_staff_certifications',
    'Get all certifications for a specific employee',
    { employeeId: z.string().uuid().describe('The employee UUID') },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { requiredPermission: 'cert.list_all' } as any,
    async ({ employeeId }, context) => {
      const { tenantId } = extractAuthContext(context.authInfo)
      const db = getDb()

      const rows = await withTenantRLS(db, tenantId, (tx) =>
        tx
          .select({
            id: certifications.id,
            displayName: certificateDefinitions.displayName,
            certStatus: certifications.certStatus,
            issueDate: certifications.issueDate,
            expiresAt: certifications.expiresAt,
            issuedByText: certifications.issuedByText,
          })
          .from(certifications)
          .innerJoin(certificateDefinitions, eq(certifications.certDefId, certificateDefinitions.id))
          .where(eq(certifications.employeeId, employeeId)),
      )

      const report: StaffCertReport = {
        employeeId,
        certs: rows.map((r) => ({
          id: r.id,
          displayName: r.displayName,
          certStatus: r.certStatus,
          issueDate: r.issueDate ?? null,
          expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
          issuedByText: r.issuedByText ?? null,
        })),
      }

      const response: McpModuleResponse<StaffCertReport> = {
        data: report,
        card: buildStaffCertsCard(report),
        message: `${rows.length} certification(s) found for employee ${employeeId}.`,
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(response) }] }
    },
  )
}
