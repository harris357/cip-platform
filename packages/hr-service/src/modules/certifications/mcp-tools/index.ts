import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerGetMyCertifications } from './get-my-certifications.js'
import { registerGetSubmissionStatus } from './get-submission-status.js'
// Slice 58E — `process_document` cert MCP tool deleted. Bot routes
// every upload through doc-service's `document_process` (already shipped
// in commit d9b847b); doc-service then dispatches to the cert workflow
// per the routing-map.
import { registerResolveHitl } from './resolve-hitl.js'

export function registerCertificationTools(server: McpServer): void {
  registerGetMyCertifications(server)
  registerGetSubmissionStatus(server)
  registerResolveHitl(server)
}
