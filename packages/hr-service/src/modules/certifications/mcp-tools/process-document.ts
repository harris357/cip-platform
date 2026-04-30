import { randomUUID } from 'crypto'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { McpModuleResponse } from '@cip/shared'
import { createTemporalClient } from '@cip/shared'
import { getDb } from '../../../db/index.js'
import { withTenantRLS } from '../../../db/rls.js'
import { certSubmissions } from '../../../db/schema.js'
import { extractAuthContext } from '../../../mcp-server/auth.js'
import { CertificationProcessingWorkflow } from '../workflows/index.js'

export function registerProcessDocument(server: McpServer): void {
  server.tool(
    'process_document',
    'Trigger certification processing workflow for an uploaded document',
    { objectStoreKey: z.string().describe('Object store key for the uploaded document') },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { requiredPermission: 'cert.submit' } as any,
    async ({ objectStoreKey }, context) => {
      const { tenantId, employeeId } = extractAuthContext(context.authInfo)
      const submissionId = randomUUID()
      const db = getDb()

      await withTenantRLS(db, tenantId, (tx) =>
        tx.insert(certSubmissions).values({
          id: submissionId,
          tenantId,
          submittedBy: employeeId,
          objectStoreKey,
          submissionStatus: 'pending',
        }),
      )

      const temporalClient = await createTemporalClient()
      // Workflow ID pattern: {workflowType}-{tenantId}-{entityId}
      const workflowId = `CertProcess-${tenantId}-${submissionId}`
      await temporalClient.workflow.start(CertificationProcessingWorkflow, {
        workflowId,
        taskQueue: process.env['TEMPORAL_TASK_QUEUE_HR'] ?? 'cip-hr-tasks',
        args: [{ tenantId, submissionId, employeeId, objectStoreKey }],
      })

      const response: McpModuleResponse<{ submissionId: string; workflowId: string }> = {
        data: { submissionId, workflowId },
        message: `Your certificate is being processed. Submission ID: ${submissionId}`,
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(response) }] }
    },
  )
}
