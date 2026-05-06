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
    'Grant a Keycloak realm role (`hr` or `employee`) to a specific employee. ' +
    'Scope: one employee, one realm role. ' +
    'Audience: HR only (gated on the `hr` realm role). ' +
    'Output: {employeeId, role} on success. Side effect: writes to hr_actions audit log + Keycloak. ' +
    'Required args: employeeId (UUID), role ("hr" | "employee"). ' +
    'Use for "make Jane an HR admin", "promote to HR". ' +
    'Differs from employee_grant_permission (grants an individual permission code, not a realm role) and employee_revoke_role (the inverse operation).',
    {
      employeeId: z.string().uuid(),
      role:       z.enum(['hr', 'employee']),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {
      requiredPermission: 'employee.assign_role',
      sideEffectLevel: 'write',
      whenToUse: [
        'User asks to grant a Keycloak realm role (hr | employee) to a specific employee',
        'After employee_find/employee_get returned a UUID and the user explicitly authorized the assignment',
      ],
      whenNotToUse: [
        'User wants to grant a CIP role (e.g., hr_standard) — use employee_grant_permission',
        'Granting baseline employee role on a new hire — employee_create handles this',
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
              role:       { type: 'string', enum: ['hr', 'employee'] },
            },
          },
        },
      },
    } as any,
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
        // Slice 65: keycloak subject lives in user_identity_links (cross-schema).
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
