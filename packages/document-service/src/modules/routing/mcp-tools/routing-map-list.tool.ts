// Slice 58E — `documents_routing_map_list` MCP tool.
//
// Lists the routing-map rows for the tenant plus the global zero-UUID
// fallback rows. Permission `documents.admin.routing_map.read` (seeded
// in migration 012). Output is the union of tenant-scoped and global
// rows; readers see global rows tagged `tenantId='00000000-...'`.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import type { McpModuleResponse } from '@cip/shared'

import { getPool } from '../../../db/index.js'
import { extractAuthContext } from '../../../mcp-server/auth.js'

const GLOBAL_SENTINEL = '00000000-0000-0000-0000-000000000000'

interface RoutingMapRow {
  tenantId:     string
  module:       string
  docType:      string
  taskQueue:    string
  workflowType: string
  enabled:      boolean
  notes:        string | null
  updatedAt:    string
  source:       'tenant' | 'global'
}

export function registerRoutingMapList(server: McpServer): void {
  server.tool(
    'documents_routing_map_list',
    'List all (module, doc_type) → workflow routing rules visible to the tenant. ' +
    'Scope: union of the tenant-scoped rows and the global zero-UUID fallback rows. ' +
    'Audience: ops with `documents.admin.routing_map.read`. ' +
    'Output: array of routing-map rows tagged `source=tenant|global`. ' +
    'Use when: an admin needs to inspect or audit how docs are being routed.',
    {
      module: z.string().optional().describe('Filter to a specific module (e.g. "certificate")'),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {
      requiredPermission: 'documents.admin.routing_map.read',
      sideEffectLevel: 'read',
      whenToUse: [
        'Operator is auditing how doc-service routes a (module, doc_type) pair',
        'Admin troubleshooting a "no_routing_rule" HITL parking',
      ],
      whenNotToUse: [
        'Routing must be modified — use documents_routing_map_set instead',
      ],
      commonNextTools: ['documents_routing_map_set'],
    } as any,
    async ({ module }, context) => {
      const auth = extractAuthContext(context.authInfo)

      const pool = getPool()
      // No RLS context: this is a direct read against a tenant-isolated
      // table. The query's WHERE clause filters to the auth tenant +
      // zero-UUID. The routing-map RLS policy is USING-only and would
      // return rows for the current GUC tenant only; bypass it via the
      // raw pool query (we explicitly filter by tenantId in WHERE).
      const params: unknown[] = [auth.tenantId, GLOBAL_SENTINEL]
      let where = `WHERE (tenant_id = $1 OR tenant_id = $2::uuid)`
      if (module !== undefined) {
        params.push(module)
        where += ` AND module = $${params.length}`
      }
      const result = await pool.query<{
        tenant_id:     string
        module:        string
        doc_type:      string
        task_queue:    string
        workflow_type: string
        enabled:       boolean
        notes:         string | null
        updated_at:    Date
      }>(
        `SELECT tenant_id, module, doc_type, task_queue, workflow_type, enabled, notes, updated_at
           FROM cip_documents.document_routing_map
           ${where}
           ORDER BY (tenant_id = $1) DESC, module ASC, doc_type ASC`,
        params,
      )

      const rows: RoutingMapRow[] = result.rows.map(r => ({
        tenantId:     r.tenant_id,
        module:       r.module,
        docType:      r.doc_type,
        taskQueue:    r.task_queue,
        workflowType: r.workflow_type,
        enabled:      r.enabled,
        notes:        r.notes,
        updatedAt:    r.updated_at.toISOString(),
        source:       r.tenant_id === auth.tenantId ? 'tenant' : 'global',
      }))

      const response: McpModuleResponse<{ rows: RoutingMapRow[] }> = {
        data: { rows },
        message: `Found ${rows.length} routing-map row(s).`,
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(response) }] }
    },
  )
}
