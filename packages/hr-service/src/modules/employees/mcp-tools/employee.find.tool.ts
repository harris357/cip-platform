import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getPool } from '../../../db/index.js';
import { findEmployeeByEmail } from '../../../db/queries/employees.js';
import { extractAuthContext } from '../../../mcp-server/auth.js';
import { ok, refused } from './_envelope.js';

export function registerEmployeeFind(server: McpServer): void {
  server.tool(
    'employee_find',
    'Look up an employee by email (HR only).',
    { email: z.string().email() },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {} as any,
    async (args, context) => {
      const ctx = extractAuthContext(context.authInfo);
      if (!ctx.roles.includes('hr')) {
        return refused('forbidden', 'employee_find requires the hr realm role');
      }
      const pool = getPool();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [ctx.tenantId]);
        const employee = await findEmployeeByEmail(client, ctx.tenantId, args.email.toLowerCase());
        await client.query('COMMIT');
        if (!employee) return refused('not_found', `no employee with email ${args.email} in this tenant`);
        return ok({ employee });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        return refused('internal', err instanceof Error ? err.message : String(err));
      } finally {
        client.release();
      }
    },
  );
}
