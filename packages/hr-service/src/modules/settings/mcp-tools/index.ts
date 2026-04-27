import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerGetTenantChannelConfig } from './get-tenant-channel-config.js'

export function registerSettingsTools(server: McpServer): void {
  registerGetTenantChannelConfig(server)
}
