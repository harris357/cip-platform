// Slice 58B — ingest MCP tool registry. server.ts imports
// registerIngestTools() and runs it once per request (mirrors hr-service
// stateless transport pattern).

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { registerDocumentProcess }  from './document-process.tool.js'
import { registerDocumentsStatus }  from './documents-status.tool.js'

export function registerIngestTools(server: McpServer): void {
  registerDocumentProcess(server)
  registerDocumentsStatus(server)
}
