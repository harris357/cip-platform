import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { extractAuthContext } from '../../../mcp-server/auth.js';
import { disableEmployee } from '../../../services/employee-disable.js';
import { AppError } from '../../../services/employee-onboarding.js';
import { ok, refused } from './_envelope.js';

export function registerEmployeeDisable(server: McpServer): void {
  server.tool(
    'employee_disable',
    'Disable an employee (HR only). Sets KC user enabled=false, invalidates sessions, marks employees.disabled_at.',
    {
      employeeId: z.string().uuid(),
      reason:     z.string().optional(),
    },
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
