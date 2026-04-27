import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerListStaff } from './list-staff.js'
import { registerGetEmployeeCapabilities } from './get-employee-capabilities.js'

export function registerEmployeeTools(server: McpServer): void {
  registerListStaff(server)
  registerGetEmployeeCapabilities(server)
}
