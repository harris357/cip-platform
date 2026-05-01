import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getPool } from '../../../db/index.js';
import {
  expandGroupPermissions,
  findRoleByCode,
  listGroupsForRole,
} from '../../../db/queries/roles.js';
import {
  assertPermission,
  extractAuthContext,
  PermissionDeniedError,
} from '../../../mcp-server/auth.js';
import { ok, refused } from '../../employees/mcp-tools/_envelope.js';

/**
 * Slice 42C: drill into a role — its groups (per module) and the
 * flattened, glob-expanded permissions those groups grant. Gated on
 * `employee.list`.
 */
export function registerRoleGet(server: McpServer): void {
  server.tool(
    'role_get',
    'Drill into one specific role: its composed groups and the flattened, glob-expanded permissions those groups grant. ' +
    'Scope: one role identified by its code. ' +
    'Audience: HR admins (gated on `employee.list`). ' +
    'Output: {role, groups[], permissions[]}. ' +
    'Required arg: code (role code, e.g. "hr_standard"). ' +
    'Differs from role_list (every role overview, no group/permission detail) and role_members (which employees hold this role).',
    { code: z.string().min(1) },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { requiredPermission: 'employee.list' } as any,
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
        const groups = await listGroupsForRole(client, role.id);
        // Flatten each group's permissions, deduped + glob-expanded.
        const allPerms = new Set<string>();
        for (const g of groups) {
          const expanded = await expandGroupPermissions(client, g);
          expanded.forEach(p => allPerms.add(p));
        }
        await client.query('COMMIT');
        return ok({ role, groups, permissions: Array.from(allPerms).sort() });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        return refused('internal', err instanceof Error ? err.message : String(err));
      } finally {
        client.release();
      }
    },
  );
}
