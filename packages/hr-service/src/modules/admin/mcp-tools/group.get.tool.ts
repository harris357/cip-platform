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
    'Drill into one specific permission group: its glob-expanded permissions and which roles compose it (impact analysis). ' +
    'Scope: one group identified by (module, code). ' +
    'Audience: HR admins (gated on `employee.list`). ' +
    'Output: {group, permissions[], usedByRoles[]}. ' +
    'Required args: module (e.g. "cert"), code (group code). ' +
    'Differs from group_list (every group overview) and role_get (one ROLE\'s composed groups + flattened permissions).',
    {
      module: z.string().min(1),
      code:   z.string().min(1),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {
      requiredPermission: 'employee.list',
      sideEffectLevel: 'read',
      whenToUse: [
        'User asks "what does the cert_admin group grant" / "which roles use this group"',
        'Impact analysis before editing a group',
      ],
      whenNotToUse: [
        'User wants the group catalog — use group_list',
        'User wants role detail — use role_get',
      ],
      commonNextTools: [],
      outputSchema: {
        type: 'object',
        required: ['data'],
        properties: {
          data: {
            type: 'object',
            properties: {
              group:        { type: 'object' },
              permissions:  { type: 'array', items: { type: 'string' } },
              usedByRoles:  { type: 'array' },
            },
          },
        },
      },
    } as any,
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
