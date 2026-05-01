import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerPermissionCatalogList } from './permission-catalog.list.tool.js';

// Slice 42A: admin / audit MCP tools — read-only discoverability and
// management surface for HR + operators. Slice 42C adds the role-layer
// management tools (role_list, role_get, role_members, group_list,
// group_get, permission_holders, audit_log_list).
export function registerAdminTools(server: McpServer): void {
  registerPermissionCatalogList(server);
}
