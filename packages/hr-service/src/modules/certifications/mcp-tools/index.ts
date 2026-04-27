import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerGetMyCertifications } from './get-my-certifications.js'
import { registerGetSubmissionStatus } from './get-submission-status.js'
import { registerProcessDocument } from './process-document.js'
import { registerResolveHitl } from './resolve-hitl.js'

export function registerCertificationTools(server: McpServer): void {
  registerGetMyCertifications(server)
  registerGetSubmissionStatus(server)
  registerProcessDocument(server)
  registerResolveHitl(server)
}
