import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '../../../db/index.js';
import { withTenantRLS } from '../../../db/rls.js';
import { employees, users } from '../../../db/schema.js';
import { extractAuthContext } from '../../../mcp-server/auth.js';
import { eq } from 'drizzle-orm';
import { ok, refused } from './_envelope.js';

export function registerEmployeeList(server: McpServer): void {
  server.tool(
    'employee_list',
    'List employees in the calling user\'s tenant. ' +
    'Scope: tenant-wide (every employee, paginated). ' +
    'Audience: HR only (gated on the `hr` realm role). ' +
    'Output: array of {id, email, fullName, identityType, disabledAt}. ' +
    'Optional filters: identityType, status (active|disabled), limit. ' +
    'Differs from list_staff (lighter projection for staff lookup), employee_find (single employee by exact email), and employee_get (one employee\'s full detail incl. roles + permissions).',
    {
      identityType: z.enum(['aad_federated', 'field_employee']).optional(),
      status:       z.enum(['active', 'disabled']).optional(),
      limit:        z.number().int().min(1).max(200).default(50),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {
      requiredPermission: 'employee.list',
      sideEffectLevel: 'read',
      whenToUse: [
        'User asks "list employees" / "show all staff" / "who\'s in the tenant"',
        'Bulk audit work — paginated listing',
      ],
      whenNotToUse: [
        'User names a specific employee — use employee_find or employee_get',
        'User wants a Teams adaptive card view — use list_staff',
      ],
      commonNextTools: ['employee_find', 'employee_get'],
      outputSchema: {
        type: 'object',
        required: ['data'],
        properties: {
          data: {
            type: 'object',
            properties: {
              employees: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id:           { type: 'string', format: 'uuid' },
                    email:        { type: 'string' },
                    fullName:     { type: 'string' },
                    identityType: { type: 'string' },
                    disabledAt:   { type: ['string', 'null'] },
                  },
                },
              },
              count: { type: 'number' },
            },
          },
        },
      },
    } as any,
    async (args, context) => {
      const ctx = extractAuthContext(context.authInfo);
      if (!ctx.roles.includes('hr')) {
        return refused('forbidden', 'employee_list requires the hr realm role');
      }
      const db = getDb();
      // Slice 65: identity moved to cip_platform.users — JOIN to read fullName/email/identityType.
      const rows = await withTenantRLS(db, ctx.tenantId, async (tx) => {
        let q = tx
          .select({
            id:           employees.id,
            userId:       employees.userId,
            disabledAt:   employees.disabledAt,
            employmentType: employees.employmentType,
            fullName:     users.fullName,
            email:        users.email,
            identityType: users.identityType,
          })
          .from(employees)
          .innerJoin(users, eq(users.id, employees.userId))
          .$dynamic();
        if (args.identityType) {
          q = q.where(eq(users.identityType, args.identityType));
        }
        const result = await q.limit(args.limit);
        return result;
      });
      const filtered = args.status
        ? rows.filter(r =>
            args.status === 'active' ? r.disabledAt === null : r.disabledAt !== null,
          )
        : rows;
      let userMessage: string;
      if (filtered.length === 0) {
        userMessage = '_No employees match._';
      } else {
        const lines = filtered
          .slice(0, 25)
          .map(r => `- **${r.fullName ?? '(unnamed)'}** \`<${r.email}>\`${r.disabledAt ? ' _(disabled)_' : ''}`);
        const more = filtered.length > 25 ? `\n_… and ${filtered.length - 25} more — narrow with \`status=\` or \`identityType=\`._` : '';
        userMessage = `**${filtered.length} employee${filtered.length === 1 ? '' : 's'}:**\n${lines.join('\n')}${more}`;
      }
      return ok({ employees: filtered, count: filtered.length }, userMessage);
    },
  );
}
