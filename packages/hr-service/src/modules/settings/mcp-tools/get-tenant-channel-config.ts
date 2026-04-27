import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { McpModuleResponse } from '@cip/shared'
import { getDb } from '../../../db/index.js'
import { withTenantRLS } from '../../../db/rls.js'
import { tenantSettings } from '../../../db/schema.js'
import { extractAuthContext } from '../../../mcp-server/auth.js'

export function registerGetTenantChannelConfig(server: McpServer): void {
  server.tool(
    'get_tenant_channel_config',
    'Returns the channel_config JSONB for the calling tenant (called by Teams Bot)',
    {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { requiredCapability: '' } as any,
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
