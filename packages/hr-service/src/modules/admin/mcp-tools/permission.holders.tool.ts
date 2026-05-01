import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getPool } from '../../../db/index.js';
import { listEmployeesWithPermission } from '../../../db/queries/roles.js';
import {
  assertPermission,
  extractAuthContext,
  PermissionDeniedError,
} from '../../../mcp-server/auth.js';
import { ok, refused } from '../../employees/mcp-tools/_envelope.js';

/**
 * Slice 42C: compliance question — who can do this specific thing?
 * Cuts across roles, role_groups, permission_groups, AND glob expansion.
 * `cert.approve` is held by anyone with literal 'cert.approve', the
 * prefix-glob 'cert.*', or the all-glob '*'. Gated on `employee.list`.
 */
export function registerPermissionHolders(server: McpServer): void {
  server.tool(
    'permission_holders',
    'List employees holding a specific permission (literal + glob coverage).',
    { permission: z.string().min(1) },
    async ({ permission }, context) => {
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
        const holders = await listEmployeesWithPermission(client, ctx.tenantId, permission);
        await client.query('COMMIT');
        return ok({ permission, holders, total: holders.length });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        return refused('internal', err instanceof Error ? err.message : String(err));
      } finally {
        client.release();
      }
    },
  );
}
