import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import express, { type Request, type Response, type NextFunction } from 'express'
import { registerCertificationTools } from '../modules/certifications/mcp-tools/index.js'
import { registerComplianceTools } from '../modules/compliance/mcp-tools/index.js'
import { registerEmployeeTools } from '../modules/employees/mcp-tools/index.js'
import { registerSettingsTools } from '../modules/settings/mcp-tools/index.js'

// Pull the Bearer token off the HTTP request and attach it as req.auth so that
// the MCP transport surfaces it to each tool handler as authInfo.token.
// SDK signature: handleRequest(req: IncomingMessage & { auth?: AuthInfo }, ...)
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
  const s = new McpServer({ name: 'hr-service', version: '1.0.0' })
  registerCertificationTools(s)
  registerComplianceTools(s)
  registerEmployeeTools(s)
  registerSettingsTools(s)
  return s
}

export const server = createRegisteredServer()

export async function startMcpServer(): Promise<void> {
  const app = express()
  app.use(express.json())

  // Stateless: each POST gets its own McpServer + transport instance so
  // Authorization header auth context is isolated per-request.
  app.post('/mcp', attachBearerAuth, async (req: Request, res: Response) => {
    const s = createRegisteredServer()
    // sessionIdGenerator omitted → stateless mode (no session tracking)
    const transport = new StreamableHTTPServerTransport({})
    // Transport.onclose is required by the interface but typed as optional in the SDK
    // under exactOptionalPropertyTypes — safe to cast at runtime.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await s.connect(transport as any)
    await transport.handleRequest(req, res, req.body)
  })

  const port = parseInt(process.env['MCP_PORT'] ?? '3001', 10)
  await new Promise<void>((resolve) => {
    app.listen(port, () => {
      console.log(`HR Service MCP Server listening on port ${port}`)
      resolve()
    })
  })
}
