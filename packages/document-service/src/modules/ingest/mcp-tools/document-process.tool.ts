// Slice 58B — `document_process` MCP tool.
//
// Bot streams Teams CDN bytes → this tool. We:
//   1. decode + sha256 + magic-byte check
//   2. PutObject to OVH at {tenantId}/{documentId}/{filename}
//   3. INSERT documents row (state=quarantined) + audit_event(uploaded)
//   4. Start DocumentProcessingWorkflow (phase loop)
//   5. Return { documentId, workflowId } for status tracking
//
// Permission: documents.upload (assertPermission stub from 58A is left
// in place; the real delegation lands in a future slice). Hard rule
// #6: no tenantId in input — always from authInfo.token.

import { createHash, randomUUID } from 'node:crypto'
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import {
  createTemporalClient,
  type McpModuleResponse,
} from '@cip/shared'
import { getDb } from '../../../db/index.js'
import { withActorContext } from '../../../db/rls.js'
import { documents, auditEvents } from '../../../db/schema.js'
import { extractAuthContext } from '../../../mcp-server/auth.js'
import { loadDocumentsTunables } from '../../../sensitivity/tunables.js'
import { DocumentProcessingWorkflow } from '../workflows/index.js'

let _s3: S3Client | undefined
function getS3(): S3Client {
  if (!_s3) {
    const endpoint = process.env['AWS_ENDPOINT_URL']
    _s3 = new S3Client({
      ...(endpoint ? { endpoint } : {}),
      region:         process.env['AWS_REGION']?.toLowerCase() ?? 'bhs',
      forcePathStyle: true,
      credentials: {
        accessKeyId:     process.env['AWS_ACCESS_KEY_ID'] ?? '',
        secretAccessKey: process.env['AWS_SECRET_ACCESS_KEY'] ?? '',
      },
    })
  }
  return _s3
}

export function registerDocumentProcess(server: McpServer): void {
  server.tool(
    'document_process',
    'Process an uploaded document. ' +
    'Scope: stores the file in object storage, creates a documents row, kicks off ' +
    'DocumentProcessingWorkflow (scan → features → sensitivity → classify → subject → route). ' +
    'Audience: every employee with `documents.upload`. ' +
    'Output: { documentId, workflowId } for status tracking via documents_status. ' +
    'Required args: fileBase64 (Teams CDN body, base64), fileName, mimeType. Optional: hintText, conversationId. ' +
    'Use when: the bot has captured a Teams attachment and accompanying user text. ' +
    'The bot calls this directly on file uploads; rarely invoked by an LLM planner.',
    {
      fileBase64:      z.string().describe('Base64-encoded file bytes from Teams CDN'),
      fileName:        z.string(),
      mimeType:        z.string(),
      hintText:        z.string().optional().describe("User's accompanying message, e.g. 'this is for me'"),
      sourceMessageId: z.string().optional(),
      conversationId:  z.string().optional().describe('Teams conversation id; required for streamed progress'),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {
      requiredPermission: 'documents.upload',
      sideEffectLevel: 'write',
      whenToUse: ['User uploaded a file in Teams; bot needs to start processing'],
      whenNotToUse: [
        'No file was uploaded — there is nothing to process',
        'User wants status of a prior upload — use documents_status',
      ],
      commonNextTools: ['documents_status'],
      outputSchema: {
        type: 'object',
        required: ['data'],
        properties: {
          data: {
            type: 'object',
            required: ['documentId', 'workflowId'],
            properties: {
              documentId: { type: 'string', format: 'uuid' },
              workflowId: { type: 'string' },
            },
          },
        },
      },
    } as any,
    async ({ fileBase64, fileName, mimeType, hintText, sourceMessageId, conversationId }, context) => {
      const { tenantId, employeeId } = extractAuthContext(context.authInfo)

      // 1. Decode + size guard + sha256.
      const buffer = Buffer.from(fileBase64, 'base64')
      if (buffer.length === 0) {
        throw new Error('document_process: empty file body')
      }
      // Enforce documents.av_max_file_size_mb at the MCP boundary.  Cheap
      // reject-before-PutObject path; tunable read uses the per-tenant
      // cache so this is sub-ms after the first call.
      const tunables = await loadDocumentsTunables(tenantId)
      const maxBytes = tunables.avMaxFileSizeMb * 1024 * 1024
      if (buffer.length > maxBytes) {
        throw new Error(
          `document_process: file size ${buffer.length} bytes exceeds ` +
          `tenant cap ${tunables.avMaxFileSizeMb}MB (documents.av_max_file_size_mb). ` +
          `Reduce the file or have an admin raise the cap.`,
        )
      }
      const sha256 = createHash('sha256').update(buffer).digest('hex')

      const documentId = randomUUID()
      const bucket = process.env['OBJECT_STORE_BUCKET'] ?? 'cip-uploads'
      const s3Key  = `${tenantId}/${documentId}/${fileName}`

      // 2. PutObject — bytes flow bot→doc-service→S3 once. (Hard rule #3.)
      await getS3().send(new PutObjectCommand({
        Bucket: bucket,
        Key:    s3Key,
        Body:   buffer,
        ContentType: mimeType,
      }))

      // 3. Insert documents row + audit. uploader actor context so RLS
      // policy admits the writes; lifecycle starts at quarantined.
      const db = getDb()
      await withActorContext(db, {
        tenantId,
        employeeId,
        actorRole: 'uploader',
        hasDocumentsAdminRead:    false,
        hasDocumentsAdminUnpurge: false,
        hasDocumentsAuditRead:    false,
        modulePermissionsByModule: {},
      }, async (tx) => {
        await tx.insert(documents).values({
          id:                  documentId,
          tenantId,
          uploaderEmployeeId:  employeeId,
          source:              'teams',
          ...(sourceMessageId !== undefined ? { sourceMessageId } : {}),
          ...(hintText !== undefined ? { uploaderHintText: hintText } : {}),
          s3Bucket:            bucket,
          s3Key,
          fileName,
          mimeType,
          sizeBytes:           buffer.length,
          sha256,
          lifecycleState:      'quarantined',
        })

        await tx.insert(auditEvents).values({
          tenantId,
          documentId,
          actorEmployeeId: employeeId,
          actorRole:       'uploader',
          eventType:       'uploaded',
          payload:         { fileName, mimeType, sizeBytes: buffer.length, sha256, source: 'teams' },
        })
      })

      // 4. Start workflow.
      const temporal = await createTemporalClient()
      // Workflow ID pattern: {workflowType}-{tenantId}-{entityId}
      const workflowId = `DocumentProcess-${tenantId}-${documentId}`
      // Slice 58E — forward the auth token to downstream modules so they
      // authenticate further calls (e.g. into hr-service MCP) without
      // doc-service impersonating a service principal. The token is
      // already bound to the uploader; the module receives it verbatim.
      const actorContext: Record<string, unknown> = {
        tenantId,
        employeeId,
        ...(context.authInfo?.token !== undefined ? { jwt: context.authInfo.token } : {}),
      }
      await temporal.workflow.start(DocumentProcessingWorkflow, {
        workflowId,
        taskQueue: process.env['TEMPORAL_TASK_QUEUE_DOCUMENTS'] ?? 'cip-documents-tasks',
        args: [{
          tenantId,
          documentId,
          uploaderEmployeeId: employeeId,
          ...(conversationId !== undefined ? { conversationId } : {}),
          ...(hintText !== undefined ? { uploaderHintText: hintText } : {}),
          // Slice 58E — thread storage coords so the route phase can
          // forward them to downstream modules without a re-read.
          s3Bucket: bucket,
          s3Key,
          actorContext,
        }],
      })

      const response: McpModuleResponse<{ documentId: string; workflowId: string }> = {
        data: { documentId, workflowId },
        message: `Your document is being processed. Document ID: ${documentId}`,
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(response) }] }
    },
  )
}
