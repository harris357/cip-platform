import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import type { McpModuleResponse } from '@cip/shared'
import { createTemporalClient } from '@cip/shared'
import { getDb } from '../../../db/index.js'
import { withTenantRLS } from '../../../db/rls.js'
import { certSubmissions } from '../../../db/schema.js'
import { extractAuthContext } from '../../../mcp-server/auth.js'
import { hitlDecisionSignal } from '../workflows/index.js'

export function registerResolveHitl(server: McpServer): void {
  server.tool(
    'resolve_hitl',
    'Resolve a stuck certification submission that requires human review. ' +
    'Scope: one submission awaiting HITL (human-in-the-loop) resolution. ' +
    'Audience: HR / approver (gated on `cert.approve`). ' +
    'Output: signal sent to workflow. The workflow continues processing once resolved. ' +
    'Required args: submissionId (UUID), approved (bool). Optional: correctedFields (key→value), notes. ' +
    'Use for "approve cert submission X", "reject the upload", "fix the OCR data and continue". ' +
    'Differs from process_document (creates a new submission) and get_submission_status (read-only inspection).',
    {
      submissionId: z.string().uuid().describe('The submission UUID awaiting HITL resolution'),
      approved: z.boolean().describe('Whether the certification is approved'),
      correctedFields: z
        .record(z.string())
        .optional()
        .describe('Corrected field values if any'),
      notes: z.string().optional().describe('Reviewer notes'),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { requiredPermission: 'cert.approve' } as any,
    async ({ submissionId, approved, correctedFields }, context) => {
      const { tenantId, employeeId } = extractAuthContext(context.authInfo)
      const db = getDb()

      const rows = await withTenantRLS(db, tenantId, (tx) =>
        tx
          .select({ workflowId: certSubmissions.workflowId })
          .from(certSubmissions)
          .where(eq(certSubmissions.id, submissionId)),
      )
      const workflowId = rows[0]?.workflowId
      if (!workflowId)
        throw new Error(`Submission ${submissionId} has no active workflow`)

      const temporalClient = await createTemporalClient()
      const handle = temporalClient.workflow.getHandle(workflowId)
      await handle.signal(hitlDecisionSignal, {
        approved,
        reviewedBy: employeeId,
        reviewedAt: new Date().toISOString(),
        ...(correctedFields !== undefined ? { correctedFields } : {}),
      })

      const response: McpModuleResponse<{ signalSent: boolean; workflowId: string }> = {
        data: { signalSent: true, workflowId },
        message: `HITL decision sent for submission ${submissionId}.`,
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(response) }] }
    },
  )
}
