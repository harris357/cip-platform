import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getPool } from '../../../db/index.js';
import { findEmployeeById } from '../../../db/queries/employees-extra.js';
import { extractAuthContext } from '../../../mcp-server/auth.js';
import { getKcAdmin, kcAdminRequest } from '../../../services/keycloak-admin.js';
import { recordHrAction } from '../../../services/audit.js';
import { findEmployeeByKeycloakId } from '../../../db/queries/employees.js';
import { ok, refused } from './_envelope.js';

export function registerEmployeeRevokeRole(server: McpServer): void {
  server.tool(
    'employee_revoke_role',
    'Revoke a Keycloak realm role from a specific employee. ' +
    'Scope: one employee, one realm role. ' +
    'Audience: HR only (gated on the `hr` realm role). ' +
    'Output: {employeeId, role} on success. Side effect: writes to hr_actions audit log + Keycloak. ' +
    'Required args: employeeId (UUID), role ("hr"). NOTE: cannot revoke the baseline "employee" role — use employee_disable instead. ' +
    'Use for "remove HR admin from Jane", "demote". ' +
    'Differs from employee_revoke_permission (revokes an individual permission, not a realm role) and employee_assign_role (the inverse).',
    {
      employeeId: z.string().uuid(),
      role:       z.enum(['hr', 'employee']),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {
      requiredPermission: 'employee.revoke_role',
      sideEffectLevel: 'write',
      whenToUse: [
        'User asks to remove the Keycloak hr realm role from a specific employee',
      ],
      whenNotToUse: [
        'User wants to terminate access entirely — use employee_disable',
        'User wants to remove a CIP role — use employee_revoke_permission',
        'Trying to revoke baseline "employee" role — refused; use employee_disable',
      ],
      commonNextTools: ['employee_get'],
      outputSchema: {
        type: 'object',
        required: ['data'],
        properties: {
          data: {
            type: 'object',
            properties: {
              employeeId: { type: 'string', format: 'uuid' },
              role:       { type: 'string' },
            },
          },
        },
      },
    } as any,
    async (args, context) => {
      const ctx = extractAuthContext(context.authInfo);
      if (!ctx.roles.includes('hr')) {
        return refused('forbidden', 'employee_revoke_role requires the hr realm role');
      }
      // The baseline 'employee' role cannot be revoked (per the policy decision
      // in users-roles-auth-normalization-plan.md). Use employee.disable to
      // terminate access entirely.
      if (args.role === 'employee') {
        return refused(
          'cannot_revoke_baseline',
          'Cannot revoke the baseline "employee" role. Use employee_disable to terminate access.',
        );
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
        if (!target)            return refused('not_found', `employee ${args.employeeId} not found`);
        // Slice 65: keycloak subject moved to user_identity_links.
        const kcLookup = await client.query<{ subject: string }>(
          `SELECT subject FROM cip_platform.user_identity_links
            WHERE user_id = $1 AND provider = 'keycloak' LIMIT 1`,
          [target.userId],
        );
        const kcSubject = kcLookup.rows[0]?.subject;
        if (!kcSubject) return refused('not_found', 'target user has no keycloak identity link');
        kcUserId = kcSubject;
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
      const delResp = await kcAdminRequest(
        admin, 'DELETE', `/users/${kcUserId}/role-mappings/realm`, [roleRep],
      );
      if (!delResp.ok && delResp.status !== 204) {
        await recordHrAction({
          tenantId: ctx.tenantId, actorEmployeeId,
          actionType: 'employee.revoke_role', targetEmployeeId: args.employeeId,
          payload: { role: args.role },
          result: 'failed', errorCode: 'kc_revoke_failed',
          errorMessage: `HTTP ${delResp.status}`,
        });
        return refused('kc_revoke_failed', `KC role revoke HTTP ${delResp.status}`);
      }

      await recordHrAction({
        tenantId: ctx.tenantId, actorEmployeeId,
        actionType: 'employee.revoke_role', targetEmployeeId: args.employeeId,
        payload: { role: args.role }, result: 'success',
      });
      return ok({ employeeId: args.employeeId, role: args.role });
    },
  );
}
