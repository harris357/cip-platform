import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { and, eq, gt, lte } from 'drizzle-orm'
import type { McpModuleResponse } from '@cip/shared'
import { getDb } from '../../../db/index.js'
import { withTenantRLS } from '../../../db/rls.js'
import { certifications, employees, certificateDefinitions } from '../../../db/schema.js'
import { extractAuthContext } from '../../../mcp-server/auth.js'
import { buildExpiryCard, type ExpiringCertGroup } from './cards/expiry-card.js'

export function registerGetExpiringCertifications(server: McpServer): void {
  server.tool(
    'get_expiring_certifications',
    'Get certifications expiring within the specified number of days',
    { daysAhead: z.number().int().min(1).max(365).default(90).describe('Days ahead to check') },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { requiredCapability: 'viewTeamCerts' } as any,
    async ({ daysAhead }, context) => {
      const { tenantId } = extractAuthContext(context.authInfo)
      const db = getDb()
      const now = new Date()
      const cutoff = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000)

      const rows = await withTenantRLS(db, tenantId, (tx) =>
        tx
          .select({
            employeeId: employees.id,
            fullName: employees.fullName,
            email: employees.email,
            displayName: certificateDefinitions.displayName,
            expiresAt: certifications.expiresAt,
          })
          .from(certifications)
          .innerJoin(employees, eq(certifications.employeeId, employees.id))
          .innerJoin(certificateDefinitions, eq(certifications.certDefId, certificateDefinitions.id))
          .where(
            and(
              eq(certifications.certStatus, 'valid'),
              gt(certifications.expiresAt, now),
              lte(certifications.expiresAt, cutoff),
            ),
          ),
      )

      const grouped = new Map<string, ExpiringCertGroup>()
      for (const row of rows) {
        if (!grouped.has(row.employeeId)) {
          grouped.set(row.employeeId, {
            employee: { id: row.employeeId, fullName: row.fullName, email: row.email },
            certs: [],
          })
        }
        const expiresAt = row.expiresAt!
        const daysRemaining = Math.ceil(
          (expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
        )
        grouped.get(row.employeeId)!.certs.push({
          displayName: row.displayName,
          expiresAt: expiresAt.toISOString(),
          daysRemaining,
        })
      }

      const groups = Array.from(grouped.values())
      const response: McpModuleResponse<ExpiringCertGroup[]> = {
        data: groups,
        card: buildExpiryCard(groups),
        message: `${groups.length} employee(s) have certs expiring within ${daysAhead} days.`,
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(response) }] }
    },
  )
}
