import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import type { McpModuleResponse } from '@cip/shared'
import { getDb } from '../../../db/index.js'
import { withTenantRLS } from '../../../db/rls.js'
import { certSubmissions } from '../../../db/schema.js'
import { extractAuthContext } from '../../../mcp-server/auth.js'
import { buildSubmissionStatusCard } from './cards/submission-status-card.js'

type SubmissionRow = typeof certSubmissions.$inferSelect

export function registerGetSubmissionStatus(server: McpServer): void {
  server.tool(
    'get_submission_status',
    'Get the status of a specific certification submission',
    { submissionId: z.string().uuid().describe('The submission UUID') },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { requiredPermission: 'cert.view_own' } as any,
    async ({ submissionId }, context) => {
      const { tenantId } = extractAuthContext(context.authInfo)
      const db = getDb()
      const rows = await withTenantRLS(db, tenantId, (tx) =>
        tx.select().from(certSubmissions).where(eq(certSubmissions.id, submissionId)),
      )
      const submission = rows[0] ?? null
      const response: McpModuleResponse<SubmissionRow | null> = {
        data: submission,
        ...(submission ? { card: buildSubmissionStatusCard(submission) } : {}),
        message: submission
          ? `Submission status: ${submission.submissionStatus}`
          : `Submission ${submissionId} not found.`,
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(response) }] }
    },
  )
}
