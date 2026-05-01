import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { extractAuthContext } from '../../../mcp-server/auth.js';
import { disableEmployee } from '../../../services/employee-disable.js';
import { AppError } from '../../../services/employee-onboarding.js';
import { ok, refused } from './_envelope.js';

export function registerEmployeeDisable(server: McpServer): void {
  server.tool(
    'employee_disable',
    'Permanently disable a specific employee (off-board). ' +
    'Scope: one employee. ' +
    'Audience: HR only (gated on the `hr` realm role). ' +
    'Output: {employeeId, disabledAt} on success. Side effects: KC user enabled=false, all sessions invalidated, employees.disabled_at set, hr_actions audit row written. ' +
    'Required arg: employeeId (UUID). Optional: reason (recorded in audit). ' +
    'Use for "fire", "off-board", "deactivate", "terminate access". ' +
    'Differs from employee_revoke_role (removes one role; user keeps baseline access). This is the irreversible terminate operation.',
    {
      employeeId: z.string().uuid(),
      reason:     z.string().optional(),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { requiredPermission: 'employee.disable' } as any,
    async (args, context) => {
      const ctx = extractAuthContext(context.authInfo);
      if (!ctx.roles.includes('hr')) {
        return refused('forbidden', 'employee_disable requires the hr realm role');
      }
      try {
        const result = await disableEmployee({
          tenantId:        ctx.tenantId,
          actorKeycloakId: ctx.employeeId,
          employeeId:      args.employeeId,
          ...(args.reason !== undefined ? { reason: args.reason } : {}),
        });
        return ok(result, `Disable started (workflow ${result.workflowId})`);
      } catch (err) {
        if (err instanceof AppError) return refused(err.code, err.message);
        return refused('internal', err instanceof Error ? err.message : String(err));
      }
    },
  );
}
