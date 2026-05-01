import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getPool } from '../../../db/index.js';
import {
  expandGroupPermissions,
  findGroupByCode,
  listRolesContainingGroup,
} from '../../../db/queries/roles.js';
import {
  assertPermission,
  extractAuthContext,
  PermissionDeniedError,
} from '../../../mcp-server/auth.js';
import { ok, refused } from '../../employees/mcp-tools/_envelope.js';

/**
 * Slice 42C: drill into a group — its (glob-expanded) permissions and
 * which roles include it (impact analysis: "if I change this group,
 * what roles change?"). Gated on `employee.list`.
 */
export function registerGroupGet(server: McpServer): void {
  server.tool(
    'group_get',
    'Get a permission group\'s detail: permissions + which roles include it.',
    {
      module: z.string().min(1),
      code:   z.string().min(1),
    },
    async ({ module, code }, context) => {
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
        const group = await findGroupByCode(client, ctx.tenantId, module, code);
        if (!group) {
          await client.query('COMMIT');
          return refused('not_found', `group '${code}' in module '${module}' not found`);
        }
        const permissions = await expandGroupPermissions(client, group);
        const usedByRoles = await listRolesContainingGroup(client, group.id);
        await client.query('COMMIT');
        return ok({ group, permissions, usedByRoles });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        return refused('internal', err instanceof Error ? err.message : String(err));
      } finally {
        client.release();
      }
    },
  );
}
