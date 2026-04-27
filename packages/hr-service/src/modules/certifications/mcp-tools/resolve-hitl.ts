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
    'Send a HITL decision signal to the certification processing workflow',
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
    { requiredCapability: 'resolveHitl' } as any,
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
