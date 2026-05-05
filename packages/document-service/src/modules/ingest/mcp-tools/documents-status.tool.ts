// Slice 58B — `documents_status` MCP tool. Poll fallback for the bot
// when the progress NATS channel didn't deliver, and a useful read
// path for ops / debugging.
//
// Permissions: documents.own.read for self; admins covered by
// documents.admin.read. The access decision goes through canRead()
// (TS mirror of the SQL RLS policy) so we can return a friendly
// "permission denied" instead of the row simply not appearing.

import { eq } from 'drizzle-orm'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import type { McpModuleResponse } from '@cip/shared'
import { getDb } from '../../../db/index.js'
import { systemActorContext, withActorContext } from '../../../db/rls.js'
import { documents } from '../../../db/schema.js'
import { canRead, type PolicyDoc } from '../../../lifecycle/access-policy.js'
import { extractAuthContext } from '../../../mcp-server/auth.js'
import type { LifecycleState } from '../../../lifecycle/states.js'

interface StatusPayload {
  documentId:        string
  lifecycleState:    LifecycleState
  fileName:          string
  mimeType:          string
  sizeBytes:         number
  sha256:            string
  uploaderEmployeeId: string | null
  sensitivityTier:   string | null
  layoutFingerprint: string | null
  pageCount:         number | null
  scannedAt:         string | null
  classifiedAt:      string | null
  routedAt:          string | null
  archivedAt:        string | null
  reason?:           string
}

export function registerDocumentsStatus(server: McpServer): void {
  server.tool(
    'documents_status',
    'Get current processing status for a document by ID. ' +
    'Scope: one document; identified by UUID. ' +
    'Audience: uploader (their own docs) or anyone with `documents.admin.read`. ' +
    'Output: lifecycle state + key fields (sensitivity tier, page count, scan timestamps). ' +
    'Required arg: documentId (UUID returned by document_process). ' +
    'Use when the bot or operator wants to know whether processing finished and what the verdict was.',
    { documentId: z.string().uuid().describe('UUID of the document to query') },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {
      requiredPermission: 'documents.own.read',
      sideEffectLevel: 'read',
      whenToUse: [
        'Bot is checking whether a prior document_process call has completed',
        'Operator is debugging "did my upload go through"',
      ],
      whenNotToUse: [
        'No document_process has been called — there is no documentId yet',
        'Need to start a new processing run — use document_process',
      ],
      commonNextTools: [],
    } as any,
    async ({ documentId }, context) => {
      const auth = extractAuthContext(context.authInfo)
      const db = getDb()

      // Use system context for read since access-policy.canRead() runs
      // in TS regardless of RLS. The DB row is filtered by tenant id
      // in the WHERE clause; cross-tenant leakage is impossible.
      const row = await withActorContext(db, systemActorContext(auth.tenantId), async (tx) => {
        const rows = await tx.select().from(documents).where(eq(documents.id, documentId))
        return rows[0]
      })

      if (!row || row.tenantId !== auth.tenantId) {
        const response: McpModuleResponse<null> = {
          data: null,
          message: `Document ${documentId} not found.`,
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify(response) }] }
      }

      // canRead reproduces the SQL RLS policy in TS so we can return
      // a friendlier denial than "row not found".
      const policyDoc: PolicyDoc = {
        uploaderEmployeeId: row.uploaderEmployeeId,
        subjectEmployeeId:  row.subjectEmployeeId,
        module:             row.module,
        lifecycleState:     row.lifecycleState as LifecycleState,
      }
      const decision = canRead(
        {
          tenantId:   auth.tenantId,
          employeeId: auth.employeeId,
          actorRole:  'reader',
          hasDocumentsAdminRead:    auth.roles.includes('documents.admin.read'),
          hasDocumentsAdminUnpurge: auth.roles.includes('documents.admin.unpurge'),
          hasDocumentsAuditRead:    auth.roles.includes('documents.audit.read'),
          modulePermissionsByModule: {},
        },
        policyDoc,
      )

      if (!decision.allowed) {
        const response: McpModuleResponse<null> = {
          data: null,
          message: `Permission denied: ${decision.reason}`,
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify(response) }] }
      }

      const generic = (row.genericFeatures ?? {}) as { pageCount?: number }
      const payload: StatusPayload = {
        documentId:        row.id,
        lifecycleState:    row.lifecycleState as LifecycleState,
        fileName:          row.fileName,
        mimeType:          row.mimeType,
        sizeBytes:         row.sizeBytes,
        sha256:            row.sha256,
        uploaderEmployeeId: row.uploaderEmployeeId,
        sensitivityTier:   row.sensitivityTier,
        layoutFingerprint: row.layoutFingerprint,
        pageCount:         typeof generic.pageCount === 'number' ? generic.pageCount : null,
        scannedAt:         row.scannedAt    ? row.scannedAt.toISOString()    : null,
        classifiedAt:      row.classifiedAt ? row.classifiedAt.toISOString() : null,
        routedAt:          row.routedAt     ? row.routedAt.toISOString()     : null,
        archivedAt:        row.archivedAt   ? row.archivedAt.toISOString()   : null,
        ...(row.stateReason ? { reason: row.stateReason } : {}),
      }

      const response: McpModuleResponse<StatusPayload> = {
        data: payload,
        message: `Document ${documentId} is in state '${row.lifecycleState}'.`,
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(response) }] }
    },
  )
}
