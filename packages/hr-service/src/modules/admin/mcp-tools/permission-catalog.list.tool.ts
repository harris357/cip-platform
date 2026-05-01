import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getPool } from '../../../db/index.js';
import { listCatalogEntries } from '../../../db/queries/permission-catalog.js';
import { extractAuthContext } from '../../../mcp-server/auth.js';
import { ok } from '../../employees/mcp-tools/_envelope.js';

/**
 * Slice 42A: list every permission code defined in the platform catalog.
 * Read-only metadata about the platform's capabilities — no permission
 * gate. Useful for HR audit ("what could a hr_admin do?") and for
 * operators designing custom groups.
 */
export function registerPermissionCatalogList(server: McpServer): void {
  server.tool(
    'permission_catalog_list',
    'List every permission CODE defined in the platform catalog (read-only metadata about what permissions EXIST). ' +
    'Scope: platform-wide catalog (not tenant-scoped — these are the defined codes, e.g. "cert.approve", "employee.create"). ' +
    'Audience: every authenticated employee (no gate; read-only metadata). ' +
    'Output: {entries[], total, filter} — entries are {service, module, code, label, description}. ' +
    'Optional filters: service, module. ' +
    'Use for "what permission codes exist", "what could a role have", or designing custom groups. ' +
    'Differs from group_list (lists GROUPS that bundle permissions in a tenant) and permission_holders (lists employees holding a specific permission).',
    {
      service: z.string().min(1).optional(),
      module:  z.string().min(1).optional(),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { requiredPermission: null } as any,
    async (args, context) => {
      // Extract auth so the call is at least authenticated; no permission gate.
      extractAuthContext(context.authInfo);

      const pool = getPool();
      const client = await pool.connect();
      try {
        const filter: { service?: string; module?: string } = {};
        if (args.service !== undefined) filter.service = args.service;
        if (args.module  !== undefined) filter.module  = args.module;
        const rows = await listCatalogEntries(client, filter);
        return ok({
          entries: rows,
          total:   rows.length,
          filter:  args,
        });
      } finally {
        client.release();
      }
    },
  );
}
