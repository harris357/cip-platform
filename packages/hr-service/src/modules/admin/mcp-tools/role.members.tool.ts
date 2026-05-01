import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getPool } from '../../../db/index.js';
import { findRoleByCode, listEmployeesForRole } from '../../../db/queries/roles.js';
import {
  assertPermission,
  extractAuthContext,
  PermissionDeniedError,
} from '../../../mcp-server/auth.js';
import { ok, refused } from '../../employees/mcp-tools/_envelope.js';

/**
 * Slice 42C: reverse query — who has this role? Useful for compliance
 * ("who's an HR admin in this tenant?"). Gated on `employee.list`.
 */
export function registerRoleMembers(server: McpServer): void {
  server.tool(
    'role_members',
    'List employees assigned a given CIP role.',
    { code: z.string().min(1) },
    async ({ code }, context) => {
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
        const role = await findRoleByCode(client, ctx.tenantId, code);
        if (!role) {
          await client.query('COMMIT');
          return refused('not_found', `role '${code}' not found`);
        }
        const members = await listEmployeesForRole(client, role.id);
        await client.query('COMMIT');
        return ok({ role: role.code, members, total: members.length });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        return refused('internal', err instanceof Error ? err.message : String(err));
      } finally {
        client.release();
      }
    },
  );
}
