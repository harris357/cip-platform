import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { extractAuthContext } from '../../../mcp-server/auth.js';
import { onboardEmployee, AppError } from '../../../services/employee-onboarding.js';
import { ok, refused } from './_envelope.js';

export function registerEmployeeCreate(server: McpServer): void {
  server.tool(
    'employee_create',
    'Provision a new employee (HR only). Creates the employees row and starts EmployeeOnboardingWorkflow.',
    {
      email:          z.string().email(),
      fullName:       z.string().min(1),
      identityType:   z.enum(['aad_federated', 'field_employee']),
      aadOid:         z.string().min(8).optional(),
      phone:          z.string().min(7).optional(),
      employmentType: z.enum(['employee', 'contractor']).optional(),
    },
    async (args, context) => {
      const ctx = extractAuthContext(context.authInfo);
      if (!ctx.roles.includes('hr')) {
        return refused('forbidden', 'employee_create requires the hr realm role');
      }
      try {
        const result = await onboardEmployee({
          tenantId:        ctx.tenantId,
          actorKeycloakId: ctx.employeeId,    // sub from JWT
          email:           args.email,
          fullName:        args.fullName,
          identityType:    args.identityType,
          ...(args.aadOid         !== undefined ? { aadOid:         args.aadOid }         : {}),
          ...(args.phone          !== undefined ? { phone:          args.phone }          : {}),
          ...(args.employmentType !== undefined ? { employmentType: args.employmentType } : {}),
        });
        return ok(result, `Employee created (workflow ${result.workflowId})`);
      } catch (err) {
        if (err instanceof AppError) {
          return refused(err.code, err.message);
        }
        return refused('internal', err instanceof Error ? err.message : String(err));
      }
    },
  );
}
