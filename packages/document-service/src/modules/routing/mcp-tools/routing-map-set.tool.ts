// Slice 58E — `documents_routing_map_set` MCP tool.
//
// Inserts or updates a (tenantId, module, doc_type) routing rule for
// the tenant. Permission `documents.admin.routing_map.write` (seeded
// in migration 012). Tenant-scoped writes only: the global zero-UUID
// rows are platform-managed via SQL migrations (seed migration 011),
// not via this tool.
//
// Hard rule #6 (memory): tenantId is NEVER a tool input — it comes
// from authInfo.token. The (module, doc_type) PK uniquely identifies
// the row; conflict updates the value columns.

import { sql } from 'drizzle-orm'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import type { McpModuleResponse } from '@cip/shared'

import { getDb } from '../../../db/index.js'
import { systemActorContext, withActorContext } from '../../../db/rls.js'
import { documentRoutingMap } from '../../../db/schema.js'
import { extractAuthContext } from '../../../mcp-server/auth.js'

interface SetResult {
  tenantId:     string
  module:       string
  docType:      string
  taskQueue:    string
  workflowType: string
  enabled:      boolean
  action:       'inserted' | 'updated'
}

export function registerRoutingMapSet(server: McpServer): void {
  server.tool(
    'documents_routing_map_set',
    'Insert or update a routing rule for a (module, doc_type) pair. ' +
    'Scope: tenant-scoped — global rows are platform-managed via SQL migrations. ' +
    'Audience: ops with `documents.admin.routing_map.write`. ' +
    'Required args: module, docType, taskQueue, workflowType. Optional: enabled (default true), notes. ' +
    'Use when: a tenant needs a non-default downstream workflow (e.g. a custom cert handler).',
    {
      module:       z.string().describe('Module name; e.g. "certificate"'),
      docType:      z.string().describe('Doc type; "*" for catchall within the module'),
      taskQueue:    z.string().describe('Temporal task queue the downstream workflow runs on'),
      workflowType: z.string().describe('Temporal workflow type (registered name on that queue)'),
      enabled:      z.boolean().optional().describe('Default true; set false to suspend a rule without deleting it'),
      notes:        z.string().optional().describe('Free-text rationale (visible in audit + list output)'),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {
      requiredPermission: 'documents.admin.routing_map.write',
      sideEffectLevel: 'write',
      whenToUse: [
        'Tenant needs a custom cert (or other module) workflow',
        'Suspending a routing rule without dropping the row (set enabled=false)',
      ],
      whenNotToUse: [
        'You only need to read existing rules — use documents_routing_map_list',
      ],
      commonNextTools: ['documents_routing_map_list'],
    } as any,
    async ({ module, docType, taskQueue, workflowType, enabled, notes }, context) => {
      const auth = extractAuthContext(context.authInfo)
      const db = getDb()

      // Detect insert-vs-update by counting existing row first; PG ON
      // CONFLICT ... RETURNING doesn't differentiate the two cases
      // cleanly via xmax, and the count is cheap.
      const action: 'inserted' | 'updated' = await withActorContext(
        db,
        systemActorContext(auth.tenantId, auth.employeeId),
        async (tx) => {
          const existing = await tx.execute<{ count: number }>(
            sql`SELECT COUNT(*)::int AS count FROM cip_documents.document_routing_map
                  WHERE tenant_id = ${auth.tenantId}
                    AND module    = ${module}
                    AND doc_type  = ${docType}`,
          )
          // drizzle execute returns rows on the .rows property for pg.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const rows = (existing as unknown as { rows: Array<{ count: number }> }).rows
          const isUpdate = (rows[0]?.count ?? 0) > 0

          await tx.insert(documentRoutingMap).values({
            tenantId:     auth.tenantId,
            module,
            docType,
            taskQueue,
            workflowType,
            enabled:      enabled ?? true,
            ...(notes !== undefined ? { notes } : {}),
            updatedBy:    auth.employeeId,
          }).onConflictDoUpdate({
            target: [
              documentRoutingMap.tenantId,
              documentRoutingMap.module,
              documentRoutingMap.docType,
            ],
            set: {
              taskQueue,
              workflowType,
              enabled:   enabled ?? true,
              notes:     notes ?? null,
              updatedAt: sql`NOW()`,
              updatedBy: auth.employeeId,
            },
          })

          return isUpdate ? 'updated' : 'inserted'
        },
      )

      const result: SetResult = {
        tenantId:     auth.tenantId,
        module,
        docType,
        taskQueue,
        workflowType,
        enabled:      enabled ?? true,
        action,
      }

      const response: McpModuleResponse<SetResult> = {
        data: result,
        message: `Routing rule ${action} for (${module}, ${docType}) → ${workflowType}@${taskQueue}.`,
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(response) }] }
    },
  )
}
