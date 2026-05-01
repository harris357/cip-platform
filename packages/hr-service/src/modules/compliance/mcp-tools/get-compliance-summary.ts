import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { McpModuleResponse } from '@cip/shared'
import { getDb } from '../../../db/index.js'
import { withTenantRLS } from '../../../db/rls.js'
import { certifications, employees } from '../../../db/schema.js'
import { extractAuthContext } from '../../../mcp-server/auth.js'
import { buildComplianceSummaryCard, type ComplianceSummary } from './cards/compliance-summary-card.js'

export function registerGetComplianceSummary(server: McpServer): void {
  server.tool(
    'get_compliance_summary',
    'Aggregate compliance statistics across all employees in the tenant (dashboard-style). ' +
    'Scope: tenant-wide aggregates (no per-employee detail). ' +
    'Audience: HR / compliance (gated on `compliance.view`). ' +
    'Output: counts by status (current, expiring soon, expired, missing), totals, percentages. ' +
    'No required args. ' +
    'Use for "what\'s our compliance status", "compliance dashboard", "are we good on certs". ' +
    'Differs from get_expiring_certifications (per-employee cert detail in a window) and get_staff_certifications (one specific employee).',
    {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { requiredPermission: 'compliance.view' } as any,
    async (_args, context) => {
      const { tenantId } = extractAuthContext(context.authInfo)
      const db = getDb()
      const now = new Date()
      const ninetyDays = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000)

      const { allEmployees, allCerts } = await withTenantRLS(db, tenantId, async (tx) => {
        const [allEmployees, allCerts] = await Promise.all([
          tx.select({ id: employees.id }).from(employees),
          tx
            .select({
              employeeId: certifications.employeeId,
              certStatus: certifications.certStatus,
              expiresAt: certifications.expiresAt,
            })
            .from(certifications),
        ])
        return { allEmployees, allCerts }
      })

      const certsByEmployee = new Map<
        string,
        Array<{ certStatus: string; expiresAt: Date | null }>
      >()
      for (const cert of allCerts) {
        if (!certsByEmployee.has(cert.employeeId)) {
          certsByEmployee.set(cert.employeeId, [])
        }
        certsByEmployee
          .get(cert.employeeId)!
          .push({ certStatus: cert.certStatus, expiresAt: cert.expiresAt })
      }

      let fullCompliance = 0
      let partialCompliance = 0
      let nonCompliant = 0
      const expiringEmployees = new Set<string>()

      for (const emp of allEmployees) {
        const certs = certsByEmployee.get(emp.id) ?? []
        const validCerts = certs.filter((c) => c.certStatus === 'valid')
        if (certs.length === 0 || validCerts.length === 0) {
          nonCompliant++
        } else if (validCerts.length === certs.length) {
          fullCompliance++
        } else {
          partialCompliance++
        }
        for (const cert of validCerts) {
          if (cert.expiresAt && cert.expiresAt > now && cert.expiresAt <= ninetyDays) {
            expiringEmployees.add(emp.id)
            break
          }
        }
      }

      const summary: ComplianceSummary = {
        totalEmployees: allEmployees.length,
        fullCompliance,
        partialCompliance,
        nonCompliant,
        expiringWithin90Days: expiringEmployees.size,
      }

      const response: McpModuleResponse<ComplianceSummary> = {
        data: summary,
        card: buildComplianceSummaryCard(summary),
        message: `${fullCompliance} of ${allEmployees.length} employee(s) fully compliant.`,
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(response) }] }
    },
  )
}
