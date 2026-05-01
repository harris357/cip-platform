import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getPool } from '../../../db/index.js';
import { findEmployeeById } from '../../../db/queries/employees-extra.js';
import {
  getPermissionsForEmployee,
  getRoleCodesForEmployee,
} from '../../../db/queries/permissions.js';
import {
  assertPermission,
  extractAuthContext,
  PermissionDeniedError,
} from '../../../mcp-server/auth.js';
import { ok, refused } from './_envelope.js';

/**
 * Slice 42C: return another employee's full detail — identity row + role
 * codes + flattened (glob-expanded) permissions. The existing
 * `get_employee_permissions` tool only handles the calling user; this
 * one is for HR managing OTHER users. Gated on `employee.find`.
 */
export function registerEmployeeGet(server: McpServer): void {
  server.tool(
    'employee_get',
    'Get a specific employee\'s full detail: identity row, assigned roles, effective permissions (glob-expanded). ' +
    'Scope: one specific OTHER employee (not the caller). For the caller\'s own roles, use get_employee_permissions instead. ' +
    'Audience: HR-level admins (gated on `employee.find` permission). ' +
    'Output: {employee, roles[], permissions[]}. ' +
    'Required arg: employeeId (UUID). ' +
    'Differs from get_employee_permissions (caller\'s own roles, no admin gate), employee_find (lookup by email, identity row only), employee_list (tenant-wide list).',
    { employeeId: z.string().uuid() },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {
      requiredPermission: 'employee.find',
      sideEffectLevel: 'read',
      whenToUse: [
        'User wants the FULL detail of one specific employee (identity + roles + permissions)',
        'After employee_find or employee_list returned a UUID, drill into one record',
      ],
      whenNotToUse: [
        'Caller asks about themselves — use get_employee_permissions',
        'No UUID known yet — use employee_find by email first',
      ],
      commonNextTools: ['employee_assign_role', 'employee_revoke_role', 'employee_grant_permission', 'employee_revoke_permission', 'employee_disable'],
      outputSchema: {
        type: 'object',
        required: ['data'],
        properties: {
          data: {
            type: 'object',
            properties: {
              employee:    { type: 'object' },
              roles:       { type: 'array', items: { type: 'string' } },
              permissions: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
    } as any,
    async ({ employeeId }, context) => {
      const ctx = extractAuthContext(context.authInfo);
      try {
        await assertPermission(context.authInfo, 'employee.find');
      } catch (err) {
        if (err instanceof PermissionDeniedError) return refused('permission_denied', err.message);
        throw err;
      }

      const pool = getPool();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [ctx.tenantId]);
        const employee = await findEmployeeById(client, ctx.tenantId, employeeId);
        if (!employee) {
          await client.query('COMMIT');
          return refused('not_found', `employee ${employeeId} not found`);
        }
        const [roles, permissions] = await Promise.all([
          getRoleCodesForEmployee(client, employeeId),
          getPermissionsForEmployee(client, employeeId),
        ]);
        await client.query('COMMIT');
        return ok({ employee, roles, permissions });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        return refused('internal', err instanceof Error ? err.message : String(err));
      } finally {
        client.release();
      }
    },
  );
}
