import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '../../../db/index.js';
import { withTenantRLS } from '../../../db/rls.js';
import { employees } from '../../../db/schema.js';
import { extractAuthContext } from '../../../mcp-server/auth.js';
import { eq } from 'drizzle-orm';
import { ok, refused } from './_envelope.js';

export function registerEmployeeList(server: McpServer): void {
  server.tool(
    'employee.list',
    'List employees in the tenant (HR only). Optional filters: identityType, status (active/disabled).',
    {
      identityType: z.enum(['aad_federated', 'field_employee']).optional(),
      status:       z.enum(['active', 'disabled']).optional(),
      limit:        z.number().int().min(1).max(200).default(50),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {} as any,
    async (args, context) => {
      const ctx = extractAuthContext(context.authInfo);
      if (!ctx.roles.includes('hr')) {
        return refused('forbidden', 'employee.list requires the hr realm role');
      }
      const db = getDb();
      const rows = await withTenantRLS(db, ctx.tenantId, async (tx) => {
        let q = tx.select().from(employees).$dynamic();
        if (args.identityType) {
          q = q.where(eq(employees.identityType, args.identityType));
        }
        const result = await q.limit(args.limit);
        return result;
      });
      const filtered = args.status
        ? rows.filter(r =>
            args.status === 'active' ? r.disabledAt === null : r.disabledAt !== null,
          )
        : rows;
      return ok({ employees: filtered, count: filtered.length });
    },
  );
}
