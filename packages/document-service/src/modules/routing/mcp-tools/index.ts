// Slice 58E — routing-map admin MCP tool registry.
//
// server.ts imports registerRoutingTools() and runs it once per
// request alongside registerIngestTools() (mirrors the ingest-module
// pattern from 58B).

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { registerRoutingMapList } from './routing-map-list.tool.js'
import { registerRoutingMapSet }  from './routing-map-set.tool.js'

export function registerRoutingTools(server: McpServer): void {
  registerRoutingMapList(server)
  registerRoutingMapSet(server)
}
