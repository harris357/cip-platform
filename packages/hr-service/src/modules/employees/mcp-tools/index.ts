import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerListStaff } from './list-staff.js';
import { registerGetEmployeeCapabilities } from './get-employee-capabilities.js';
import { registerSyncEmployee } from './sync-employee.js';

// Slice 33: HR management tools — all gated on the 'hr' realm role.
import { registerEmployeeCreate }          from './employee.create.tool.js';
import { registerEmployeeList }            from './employee.list.tool.js';
import { registerEmployeeFind }            from './employee.find.tool.js';
import { registerEmployeeAssignRole }      from './employee.assign-role.tool.js';
import { registerEmployeeRevokeRole }      from './employee.revoke-role.tool.js';
import { registerEmployeeMigrateIdentity } from './employee.migrate-identity.tool.js';
import { registerEmployeeDisable }         from './employee.disable.tool.js';

export function registerEmployeeTools(server: McpServer): void {
  // Existing (every authenticated user)
  registerSyncEmployee(server);
  registerListStaff(server);
  registerGetEmployeeCapabilities(server);

  // Slice 33 (HR-gated)
  registerEmployeeCreate(server);
  registerEmployeeList(server);
  registerEmployeeFind(server);
  registerEmployeeAssignRole(server);
  registerEmployeeRevokeRole(server);
  registerEmployeeMigrateIdentity(server);
  registerEmployeeDisable(server);
}
