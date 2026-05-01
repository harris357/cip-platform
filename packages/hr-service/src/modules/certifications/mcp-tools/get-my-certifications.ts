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
    'Return the CALLER\'s own certifications and expiry dates. ' +
    'Scope: caller-only. ' +
    'Audience: every employee (gated on `cert.view_own`, baseline `employee` role permission). ' +
    'Output: list of certs with name, issue date, expiry date, status. Includes adaptive card for Teams. ' +
    'Use for "show my certs", "what certs do I have", "when does my X expire". ' +
    'Differs from get_staff_certifications (HR view of someone else\'s certs) and get_expiring_certifications (caller-scoped expiry-only filter).',
    {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {
      requiredPermission: 'cert.view_own',
      sideEffectLevel: 'read',
      whenToUse: [
        'User asks "show my certs" / "what certs do I have" / "when does my X expire"',
      ],
      whenNotToUse: [
        'User asks about another employee\'s certs — use get_staff_certifications',
        'User wants tenant-wide expiring certs — use get_expiring_certifications',
      ],
      commonNextTools: ['get_submission_status', 'process_document'],
      outputSchema: {
        type: 'object',
        required: ['data'],
        properties: {
          data: { type: 'array', items: { type: 'object' } },
          card: {},
          message: { type: 'string' },
        },
      },
    } as any,
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
