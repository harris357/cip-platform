import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import express, { type Request, type Response, type NextFunction, type Express } from 'express'
import { registerSyncUser } from './tools/sync-user.js'

// Slice 66: platform-core's first MCP server. Initially exposes only
// sync_user. Slice 69 expands with user/role/tenant tools.

function attachBearerAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization ?? ''
  if (header.startsWith('Bearer ')) {
    const token = header.slice('Bearer '.length).trim()
    if (token) {
      (req as Request & { auth?: { token: string } }).auth = { token }
    }
  }
  next()
}

function createRegisteredServer(): McpServer {
  const s = new McpServer({ name: 'platform-core', version: '1.0.0' })
  registerSyncUser(s)
  return s
}

// Mounts the MCP route on an existing Express app under /mcp/platform.
// Co-locates with the existing HTTP server (no new pod / no new port).
export function mountMcpServer(app: Express): void {
  app.post('/mcp/platform', attachBearerAuth, async (req: Request, res: Response) => {
    const s = createRegisteredServer()
    const transport = new StreamableHTTPServerTransport({})
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await s.connect(transport as any)
    await transport.handleRequest(req, res, req.body)
  })
}
