import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getPool } from '../../../db/index.js';
import { findEmployeeById } from '../../../db/queries/employees-extra.js';
import { extractAuthContext } from '../../../mcp-server/auth.js';
import { getKcAdmin, kcAdminRequest } from '../../../services/keycloak-admin.js';
import { recordHrAction } from '../../../services/audit.js';
import { findEmployeeByKeycloakId } from '../../../db/queries/employees.js';
import { ok, refused } from './_envelope.js';

export function registerEmployeeAssignRole(server: McpServer): void {
  server.tool(
    'employee_assign_role',
    'Assign a Keycloak realm role to an employee (HR only).',
    {
      employeeId: z.string().uuid(),
      role:       z.enum(['hr', 'employee']),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {} as any,
    async (args, context) => {
      const ctx = extractAuthContext(context.authInfo);
      if (!ctx.roles.includes('hr')) {
        return refused('forbidden', 'employee_assign_role requires the hr realm role');
      }

      const pool = getPool();
      const client = await pool.connect();
      let actorEmployeeId: string;
      let kcUserId: string;
      try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [ctx.tenantId]);
        const actor  = await findEmployeeByKeycloakId(client, ctx.tenantId, ctx.employeeId);
        if (!actor) return refused('actor_not_provisioned', 'caller is not an employee in this tenant');
        actorEmployeeId = actor.id;
        const target = await findEmployeeById(client, ctx.tenantId, args.employeeId);
        if (!target)              return refused('not_found', `employee ${args.employeeId} not found`);
        if (!target.keycloakId)   return refused('not_found', 'target employee has no keycloak_id');
        kcUserId = target.keycloakId;
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        return refused('internal', err instanceof Error ? err.message : String(err));
      } finally {
        client.release();
      }

      const admin = await getKcAdmin(ctx.tenantId);
      const roleResp = await kcAdminRequest(admin, 'GET', `/roles/${args.role}`);
      if (!roleResp.ok) return refused('internal', `KC role ${args.role} lookup failed: ${roleResp.status}`);
      const roleRep = await roleResp.json();
      const addResp = await kcAdminRequest(
        admin, 'POST', `/users/${kcUserId}/role-mappings/realm`, [roleRep],
      );
      if (!addResp.ok && addResp.status !== 204) {
        await recordHrAction({
          tenantId: ctx.tenantId, actorEmployeeId,
          actionType: 'employee.assign_role', targetEmployeeId: args.employeeId,
          payload: { role: args.role },
          result: 'failed', errorCode: 'kc_assign_failed',
          errorMessage: `HTTP ${addResp.status}`,
        });
        return refused('kc_assign_failed', `KC role assignment HTTP ${addResp.status}`);
      }

      await recordHrAction({
        tenantId: ctx.tenantId, actorEmployeeId,
        actionType: 'employee.assign_role', targetEmployeeId: args.employeeId,
        payload: { role: args.role }, result: 'success',
      });
      return ok({ employeeId: args.employeeId, role: args.role });
    },
  );
}
