import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerGetExpiringCertifications } from './get-expiring-certifications.js'
import { registerGetComplianceSummary } from './get-compliance-summary.js'
import { registerGetStaffCertifications } from './get-staff-certifications.js'

export function registerComplianceTools(server: McpServer): void {
  registerGetExpiringCertifications(server)
  registerGetComplianceSummary(server)
  registerGetStaffCertifications(server)
}
