import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { extractAuthContext } from '../../../mcp-server/auth.js';
import { migrateEmployeeIdentity } from '../../../services/employee-migration.js';
import { AppError } from '../../../services/employee-onboarding.js';
import { ok, refused } from './_envelope.js';

export function registerEmployeeMigrateIdentity(server: McpServer): void {
  server.tool(
    'employee_migrate_identity',
    'Switch an employee between AAD-federated and field (OTP) identity types. ' +
    'Scope: one employee, identity-type swap. ' +
    'Audience: HR only (gated on the `hr` realm role). ' +
    'Output: {employeeId, identityType} on success. ' +
    'Required args: employeeId (UUID), targetIdentityType ("aad_federated"|"field_employee"). For AAD target also aadOid; for field target also phone. ' +
    'Use for "convert to field worker", "Jane is now in our Entra tenant — re-link". Rare operation. ' +
    'No sibling overlap.',
    {
      employeeId:         z.string().uuid(),
      targetIdentityType: z.enum(['aad_federated', 'field_employee']),
      aadOid:             z.string().min(8).optional(),
      phone:              z.string().min(7).optional(),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { requiredPermission: 'employee.migrate_identity' } as any,
    async (args, context) => {
      const ctx = extractAuthContext(context.authInfo);
      if (!ctx.roles.includes('hr')) {
        return refused('forbidden', 'employee_migrate_identity requires the hr realm role');
      }
      try {
        const result = await migrateEmployeeIdentity({
          tenantId:           ctx.tenantId,
          actorKeycloakId:    ctx.employeeId,
          employeeId:         args.employeeId,
          targetIdentityType: args.targetIdentityType,
          ...(args.aadOid !== undefined ? { aadOid: args.aadOid } : {}),
          ...(args.phone  !== undefined ? { phone:  args.phone }  : {}),
        });
        return ok(result, `Migration started (workflow ${result.workflowId})`);
      } catch (err) {
        if (err instanceof AppError) return refused(err.code, err.message);
        return refused('internal', err instanceof Error ? err.message : String(err));
      }
    },
  );
}
