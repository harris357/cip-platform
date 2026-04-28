import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerListStaff } from './list-staff.js'
import { registerGetEmployeeCapabilities } from './get-employee-capabilities.js'
import { registerSyncEmployee } from './sync-employee.js'

export function registerEmployeeTools(server: McpServer): void {
  registerSyncEmployee(server)
  registerListStaff(server)
  registerGetEmployeeCapabilities(server)
}
