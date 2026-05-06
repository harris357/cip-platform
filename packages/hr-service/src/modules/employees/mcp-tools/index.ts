import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerListStaff } from './list-staff.js';
// Slice 69: get_employee_permissions moved to platform-core as get_my_permissions.
import { registerEmployeeGet } from './employee.get.tool.js';
// Slice 66: ensure_employee replaces sync_employee. The bot calls
// platform-core's sync_user first (creates User + identity links); then
// invokes this tool only when an HR-flavored tool is in the candidate set.
import { registerEnsureEmployee } from './ensure-employee.js';

// Slice 33: HR management tools — all gated on the 'hr' realm role.
import { registerEmployeeCreate }          from './employee.create.tool.js';
import { registerEmployeeList }            from './employee.list.tool.js';
import { registerEmployeeFind }            from './employee.find.tool.js';
import { registerEmployeeAssignRole }      from './employee.assign-role.tool.js';
import { registerEmployeeRevokeRole }      from './employee.revoke-role.tool.js';
import { registerEmployeeMigrateIdentity } from './employee.migrate-identity.tool.js';
import { registerEmployeeDisable }         from './employee.disable.tool.js';

// Slice 38: permission management tools — gated on 'hr' realm role +
// employee.grant_permission / employee.revoke_permission permissions.
import { registerEmployeeGrantPermission }  from './employee.grant-permission.tool.js';
import { registerEmployeeRevokePermission } from './employee.revoke-permission.tool.js';

export function registerEmployeeTools(server: McpServer): void {
  // Slice 66: ensure_employee (was sync_employee). Per-turn HR provisioning gate.
  registerEnsureEmployee(server);
  registerListStaff(server);
  // Slice 69: get_employee_permissions removed; bot calls platform-core's
  // get_my_permissions instead. Removed entirely (hard cut).

  // Slice 33 (HR-gated)
  registerEmployeeCreate(server);
  registerEmployeeList(server);
  registerEmployeeFind(server);
  registerEmployeeAssignRole(server);
  registerEmployeeRevokeRole(server);
  registerEmployeeMigrateIdentity(server);
  registerEmployeeDisable(server);

  // Slice 42C: admin read of another employee's full state
  registerEmployeeGet(server);

  // Slice 38 (HR-gated + permission-gated)
  registerEmployeeGrantPermission(server);
  registerEmployeeRevokePermission(server);
}
