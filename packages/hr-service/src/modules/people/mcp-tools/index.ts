// Slice 58D-A — people-module MCP tool barrel.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerMatchPersonList } from './match-person-list.tool.js';
import { registerMatchPersonResolve } from './match-person-resolve.tool.js';

export function registerPeopleTools(server: McpServer): void {
  registerMatchPersonList(server);
  registerMatchPersonResolve(server);
}
