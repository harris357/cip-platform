import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { extractAuthContext } from '../../../mcp-server/auth.js';
import { migrateEmployeeIdentity } from '../../../services/employee-migration.js';
import { AppError } from '../../../services/employee-onboarding.js';
import { ok, refused } from './_envelope.js';

export function registerEmployeeMigrateIdentity(server: McpServer): void {
  server.tool(
    'employee_migrate_identity',
    'Switch an employee between aad_federated and field_employee identity (HR only). For AAD target requires aadOid; for field target requires phone.',
    {
      employeeId:         z.string().uuid(),
      targetIdentityType: z.enum(['aad_federated', 'field_employee']),
      aadOid:             z.string().min(8).optional(),
      phone:              z.string().min(7).optional(),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {} as any,
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
