import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getPool } from '../../../db/index.js';
import { listHrActions } from '../../../db/queries/hr-actions.js';
import {
  assertPermission,
  extractAuthContext,
  PermissionDeniedError,
} from '../../../mcp-server/auth.js';
import { ok, refused } from '../../employees/mcp-tools/_envelope.js';

/**
 * Slice 42C: query the hr_actions audit table from Slice 32. Filterable
 * by actor, target, action type, time range. Today the table is
 * write-only via recordHrAction; this surfaces the read side. Compliance
 * question: "who granted admin access in the last week?". Gated on
 * `employee.list`.
 */
export function registerAuditLogList(server: McpServer): void {
  server.tool(
    'audit_log_list',
    'List recent HR audit events. Filter by actor, target, action type, time range.',
    {
      actorEmployeeId:  z.string().uuid().optional(),
      targetEmployeeId: z.string().uuid().optional(),
      actionType:       z.string().min(1).optional(),
      sinceIso:         z.string().datetime().optional(),
      limit:            z.number().int().min(1).max(500).optional(),
    },
    async (args, context) => {
      const ctx = extractAuthContext(context.authInfo);
      try {
        await assertPermission(context.authInfo, 'employee.list');
      } catch (err) {
        if (err instanceof PermissionDeniedError) return refused('permission_denied', err.message);
        throw err;
      }

      const pool = getPool();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [ctx.tenantId]);
        const filter: Parameters<typeof listHrActions>[2] = {};
        if (args.actorEmployeeId  !== undefined) filter.actorEmployeeId  = args.actorEmployeeId;
        if (args.targetEmployeeId !== undefined) filter.targetEmployeeId = args.targetEmployeeId;
        if (args.actionType       !== undefined) filter.actionType       = args.actionType;
        if (args.sinceIso         !== undefined) filter.sinceIso         = args.sinceIso;
        if (args.limit            !== undefined) filter.limit            = args.limit;
        const events = await listHrActions(client, ctx.tenantId, filter);
        await client.query('COMMIT');
        return ok({ events, total: events.length, filter: args });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        return refused('internal', err instanceof Error ? err.message : String(err));
      } finally {
        client.release();
      }
    },
  );
}
