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
    'List every employee in the tenant who holds a specific permission, accounting for glob expansion. ' +
    'Scope: tenant-wide (cuts across all roles + groups). ' +
    'Audience: HR admins (gated on `employee.list`). ' +
    'Output: {permission, holders[], total} — holders are {id, email, fullName}. ' +
    'Use for compliance questions ("who can approve certs?") and audits. Note that "cert.approve" is matched literally AND via "cert.*" glob AND via "*" glob. ' +
    'Required arg: permission (full code, e.g. "cert.approve"). ' +
    'Differs from role_members (members of a specific ROLE, not a permission).',
    { permission: z.string().min(1) },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { requiredPermission: 'employee.list' } as any,
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
