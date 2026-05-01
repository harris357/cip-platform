import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { extractAuthContext } from '../../../mcp-server/auth.js';
import { onboardEmployee, AppError } from '../../../services/employee-onboarding.js';
import { ok, refused } from './_envelope.js';

export function registerEmployeeCreate(server: McpServer): void {
  server.tool(
    'employee_create',
    'Provision a new employee record + kick off the onboarding workflow. ' +
    'Scope: creates one new employee in the caller\'s tenant. ' +
    'Audience: HR only (gated on the `hr` realm role). ' +
    'Output: {employeeId, workflowId} on success, or refusal {code, message}. ' +
    'Required args: email, fullName, identityType (aad_federated|field_employee). Optional: aadOid, phone, employmentType. ' +
    'Side effect: starts EmployeeOnboardingWorkflow. ' +
    'Use for "create employee", "add Jane", "onboard new hire". ' +
    'Differs from employee_assign_role (assigns a CIP role to an existing employee) and employee_migrate_identity (changes auth federation type).',
    {
      email:          z.string().email(),
      fullName:       z.string().min(1),
      identityType:   z.enum(['aad_federated', 'field_employee']),
      aadOid:         z.string().min(8).optional(),
      phone:          z.string().min(7).optional(),
      employmentType: z.enum(['employee', 'contractor']).optional(),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { requiredPermission: 'employee.create' } as any,
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
