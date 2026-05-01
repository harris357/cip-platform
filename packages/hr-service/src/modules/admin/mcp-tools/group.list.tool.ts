import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getPool } from '../../../db/index.js';
import { listGroupsByTenant } from '../../../db/queries/roles.js';
import {
  assertPermission,
  extractAuthContext,
  PermissionDeniedError,
} from '../../../mcp-server/auth.js';
import { ok, refused } from '../../employees/mcp-tools/_envelope.js';

/**
 * Slice 42C: list permission groups in the tenant. Optional `module`
 * filter. Gated on `employee.list`.
 */
export function registerGroupList(server: McpServer): void {
  server.tool(
    'group_list',
    'List permission GROUPS in the caller\'s tenant. ' +
    'Scope: tenant-wide (all groups, optionally filtered to one module). ' +
    'Audience: HR admins (gated on `employee.list`). ' +
    'Output: {groups[], total} — each group is {code, label, module, permissions[]}. ' +
    'Optional arg: module (e.g. "cert", "employee") to filter. ' +
    'Differs from role_list (lists ROLES, which compose groups) and permission_catalog_list (lists individual permissions, the atoms inside groups).',
    { module: z.string().min(1).optional() },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {
      requiredPermission: 'employee.list',
      sideEffectLevel: 'read',
      whenToUse: [
        'User asks "what permission groups exist" / "list groups in the cert module"',
      ],
      whenNotToUse: [
        'User asks about ROLES — use role_list',
        'User asks about individual permission codes — use permission_catalog_list',
      ],
      commonNextTools: ['group_get'],
      outputSchema: {
        type: 'object',
        required: ['data'],
        properties: {
          data: {
            type: 'object',
            properties: {
              groups: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    code:        { type: 'string' },
                    label:       { type: 'string' },
                    module:      { type: 'string' },
                    permissions: { type: 'array' },
                  },
                },
              },
              total:  { type: 'number' },
              filter: { type: 'object' },
            },
          },
        },
      },
    } as any,
    async ({ module }, context) => {
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
        const groups = await listGroupsByTenant(client, ctx.tenantId, module);
        await client.query('COMMIT');
        return ok({ groups, total: groups.length, filter: { module: module ?? null } });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        return refused('internal', err instanceof Error ? err.message : String(err));
      } finally {
        client.release();
      }
    },
  );
}
