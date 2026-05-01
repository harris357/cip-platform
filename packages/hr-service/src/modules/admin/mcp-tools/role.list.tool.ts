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
    'List every CIP role defined in the caller\'s tenant. ' +
    'Scope: tenant-wide (all roles, not just the caller\'s assignments). ' +
    'Audience: HR admins (gated on `employee.list` permission). ' +
    'Output: array of {code, label, group_count, keycloak_role}. ' +
    'Use for audits, role-selection UIs, "what roles exist". ' +
    'Differs from get_employee_permissions (the caller\'s OWN roles only) and employee_get (one specific employee\'s assigned roles).',
    {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {
      requiredPermission: 'employee.list',
      sideEffectLevel: 'read',
      whenToUse: [
        'User asks "what roles exist" / "list our roles" / audit role inventory',
      ],
      whenNotToUse: [
        'User asks about THEIR roles — use get_employee_permissions',
        'User asks about ONE specific employee\'s roles — use employee_get',
      ],
      commonNextTools: ['role_get', 'role_members'],
      outputSchema: {
        type: 'object',
        required: ['data'],
        properties: {
          data: {
            type: 'object',
            properties: {
              roles: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    code:          { type: 'string' },
                    label:         { type: 'string' },
                    keycloak_role: { type: 'string' },
                    group_count:   { type: 'number' },
                  },
                },
              },
              total: { type: 'number' },
            },
          },
        },
      },
    } as any,
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
