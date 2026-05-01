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
    'List every permission code defined in the platform catalog. Read-only.',
    {
      service: z.string().min(1).optional(),
      module:  z.string().min(1).optional(),
    },
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
