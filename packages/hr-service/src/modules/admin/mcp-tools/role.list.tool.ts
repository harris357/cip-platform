import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getPool } from '../../../db/index.js';
import { listRolesByTenant } from '../../../db/queries/roles.js';
import {
  assertPermission,
  extractAuthContext,
  PermissionDeniedError,
} from '../../../mcp-server/auth.js';
import { ok, refused } from '../../employees/mcp-tools/_envelope.js';

/**
 * Slice 42C: list every CIP role available in the calling user's tenant.
 * Each row carries the role's group count (how many module-scoped groups
 * it composes). Gated on `employee.list` — same threshold as listing
 * employees.
 */
export function registerRoleList(server: McpServer): void {
  server.tool(
    'role_list',
    'List CIP roles available in the calling user\'s tenant.',
    {},
    async (_args, context) => {
      const ctx = extractAuthContext(context.authInfo);
      try {
        await assertPermission(context.authInfo, 'employee.list');
      } catch (err) {
        if (err instanceof PermissionDeniedError) {
          return refused('permission_denied', err.message);
        }
        throw err;
      }

      const pool = getPool();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [ctx.tenantId]);
        const roles = await listRolesByTenant(client, ctx.tenantId);
        await client.query('COMMIT');
        return ok({ roles, total: roles.length });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        return refused('internal', err instanceof Error ? err.message : String(err));
      } finally {
        client.release();
      }
    },
  );
}
