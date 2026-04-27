import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { eq } from 'drizzle-orm'
import type { McpModuleResponse } from '@cip/shared'
import { getDb } from '../../../db/index.js'
import { withTenantRLS } from '../../../db/rls.js'
import { certifications } from '../../../db/schema.js'
import { extractAuthContext } from '../../../mcp-server/auth.js'
import { buildCertificationsCard } from './cards/certifications-card.js'

type CertRow = typeof certifications.$inferSelect

export function registerGetMyCertifications(server: McpServer): void {
  server.tool(
    'get_my_certifications',
    "Get the current employee's certifications and expiry dates",
    {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { requiredCapability: 'viewOwnCerts' } as any,
    async (_args, context) => {
      const { tenantId, employeeId } = extractAuthContext(context.authInfo)
      const db = getDb()
      const certs = await withTenantRLS(db, tenantId, (tx) =>
        tx.select().from(certifications).where(eq(certifications.employeeId, employeeId)),
      )
      const response: McpModuleResponse<CertRow[]> = {
        data: certs,
        card: buildCertificationsCard(certs),
        message: `You have ${certs.length} certification(s).`,
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(response) }] }
    },
  )
}
