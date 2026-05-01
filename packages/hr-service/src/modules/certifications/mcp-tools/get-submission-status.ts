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
    'Get processing status for one specific certification document submission. ' +
    'Scope: one submission identified by UUID. ' +
    'Audience: every employee with `cert.view_own` (baseline). ' +
    'Output: {status, processingStage, errors, extractedData}. Status flow: queued → ocr → matching → hitl_pending → resolved. ' +
    'Required arg: submissionId (UUID returned by process_document). ' +
    'Use for "what happened to the cert I uploaded", "did my cert go through". ' +
    'Differs from process_document (kicks off a NEW submission) and resolve_hitl (operator action on a stuck submission).',
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
