import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { McpModuleResponse } from '@cip/shared'
import { getDb } from '../../../db/index.js'
import { withTenantRLS } from '../../../db/rls.js'
import { tenantSettings } from '../../../db/schema.js'
import { extractAuthContext } from '../../../mcp-server/auth.js'

export function registerGetTenantChannelConfig(server: McpServer): void {
  server.tool(
    'get_tenant_channel_config',
    'Return tenant-level Teams channel mappings (which Teams channel routes to which tenant). ' +
    'Scope: caller\'s tenant only. ' +
    'Audience: every authenticated user (no gate; called internally by the bot). ' +
    'Output: {channelConfig} JSONB blob. ' +
    'Used internally by the bot\'s channel registry on every turn; rarely invoked directly by an LLM.',
    {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { requiredPermission: '' } as any,
    async (_args, context) => {
      const { tenantId } = extractAuthContext(context.authInfo)
      const db = getDb()

      const rows = await withTenantRLS(db, tenantId, (tx) =>
        tx.select({ channelConfig: tenantSettings.channelConfig }).from(tenantSettings),
      )
      const channelConfig = rows[0]?.channelConfig ?? null

      const response: McpModuleResponse<{ channelConfig: unknown }> = {
        data: { channelConfig },
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(response) }] }
    },
  )
}
