import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerPermissionCatalogList } from './permission-catalog.list.tool.js';
import { registerRoleList }              from './role.list.tool.js';
import { registerRoleGet }               from './role.get.tool.js';
import { registerRoleMembers }           from './role.members.tool.js';
import { registerGroupList }             from './group.list.tool.js';
import { registerGroupGet }              from './group.get.tool.js';
import { registerPermissionHolders }     from './permission.holders.tool.js';
import { registerAuditLogList }          from './audit-log.list.tool.js';

// Slice 42A + 42C: admin / audit MCP tools — read-only discoverability
// and compliance surface for HR + operators. CRUD tools (role_create,
// group_update, role_add_group, etc.) deferred to Slice 42D.
export function registerAdminTools(server: McpServer): void {
  registerPermissionCatalogList(server);
  registerRoleList(server);
  registerRoleGet(server);
  registerRoleMembers(server);
  registerGroupList(server);
  registerGroupGet(server);
  registerPermissionHolders(server);
  registerAuditLogList(server);
}
