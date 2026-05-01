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
    'Get an employee\'s full detail: identity, assigned roles, effective permissions.',
    { employeeId: z.string().uuid() },
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
