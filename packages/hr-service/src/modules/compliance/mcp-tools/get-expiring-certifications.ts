import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { and, eq, gt, lte } from 'drizzle-orm'
import type { McpModuleResponse } from '@cip/shared'
import { getDb } from '../../../db/index.js'
import { withTenantRLS } from '../../../db/rls.js'
import { certifications, employees, certificateDefinitions, users } from '../../../db/schema.js'
import { extractAuthContext } from '../../../mcp-server/auth.js'
import { buildExpiryCard, type ExpiringCertGroup } from './cards/expiry-card.js'

export function registerGetExpiringCertifications(server: McpServer): void {
  server.tool(
    'get_expiring_certifications',
    'Find every employee\'s certifications that expire within a given window of days (compliance overview). ' +
    'Scope: tenant-wide (all employees, not just caller). ' +
    'Audience: HR / compliance (gated on `cert.list_all`). ' +
    'Output: grouped by employee, each with their expiring certs + days remaining. Includes adaptive card. ' +
    'Required arg: daysAhead (window from today, e.g. 30, 90, 365). ' +
    'Use for "what\'s expiring in the next 30 days", "compliance check", "who needs to renew". ' +
    'Differs from get_my_certifications (caller-only, all certs) and get_compliance_summary (aggregate stats, no per-cert detail).',
    { daysAhead: z.number().int().min(1).max(365).default(90).describe('Days ahead to check') },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {
      requiredPermission: 'cert.list_all',
      sideEffectLevel: 'read',
      whenToUse: [
        'User asks "what\'s expiring soon" / "compliance check next 30 days" / "who needs to renew"',
      ],
      whenNotToUse: [
        'User wants ONE employee\'s certs — use get_staff_certifications',
        'User asks about their own — use get_my_certifications',
      ],
      commonNextTools: ['get_staff_certifications', 'employee_find'],
      outputSchema: {
        type: 'object',
        required: ['data'],
        properties: {
          data: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                employee: {
                  type: 'object',
                  properties: {
                    id:       { type: 'string', format: 'uuid' },
                    fullName: { type: 'string' },
                    email:    { type: 'string' },
                  },
                },
                certs: { type: 'array' },
              },
            },
          },
          card: {},
        },
      },
    } as any,
    async ({ daysAhead }, context) => {
      const { tenantId } = extractAuthContext(context.authInfo)
      const db = getDb()
      const now = new Date()
      const cutoff = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000)

      // Slice 65: identity moved to cip_platform.users — JOIN to read fullName/email.
      const rows = await withTenantRLS(db, tenantId, (tx) =>
        tx
          .select({
            employeeId: employees.id,
            fullName: users.fullName,
            email: users.email,
            displayName: certificateDefinitions.displayName,
            expiresAt: certifications.expiresAt,
          })
          .from(certifications)
          .innerJoin(employees, eq(certifications.employeeId, employees.id))
          .innerJoin(users, eq(users.id, employees.userId))
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
