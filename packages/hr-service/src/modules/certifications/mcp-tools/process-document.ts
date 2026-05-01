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
    'Submit a new certification document for OCR + matching processing. ' +
    'Scope: creates one new submission row + kicks off CertificationProcessingWorkflow. ' +
    'Audience: every employee with `cert.submit` (baseline). ' +
    'Output: {submissionId} for status tracking via get_submission_status. ' +
    'Required arg: objectStoreKey (S3 key from a Teams file upload — the bot uploads first, then calls this). ' +
    'Use when the user uploads a cert document (the bot routes file uploads through here automatically; rarely called by an LLM directly).',
    { objectStoreKey: z.string().describe('Object store key for the uploaded document') },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {
      requiredPermission: 'cert.submit',
      sideEffectLevel: 'write',
      whenToUse: [
        'User uploaded a cert document and the bot needs to start processing',
      ],
      whenNotToUse: [
        'User did not actually upload a file — there is no objectStoreKey to pass',
        'User wants the status of an existing submission — use get_submission_status',
      ],
      commonNextTools: ['get_submission_status'],
      outputSchema: {
        type: 'object',
        required: ['data'],
        properties: {
          data: {
            type: 'object',
            required: ['submissionId'],
            properties: { submissionId: { type: 'string', format: 'uuid' } },
          },
        },
      },
    } as any,
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
