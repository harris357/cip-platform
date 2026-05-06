// Slice 58A — minimal HTTP server. Slice 58B mounts the MCP transport
// and registers ingest tools (document_process + documents_status).
//
// Endpoints:
//   - GET  /healthz        liveness
//   - GET  /readyz         readiness (DB + clamav reachable)
//   - POST /mcp            MCP streamable-http transport (stateless)

import express, { type Request, type Response, type NextFunction } from 'express'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'

import { getPool } from './db/index.js'
import { ClamAVClient } from './av/clamav-client.js'
import { registerIngestTools } from './modules/ingest/mcp-tools/index.js'
// Slice 58E — routing-map admin tools.
import { registerRoutingTools } from './modules/routing/mcp-tools/index.js'

const PORT = Number(process.env['PORT'] ?? 3000)

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

// Slice 69: per-module MCP endpoints. /mcp split into /mcp/ingest +
// /mcp/routing. Each endpoint registers ONLY that module's tools.
interface ModuleSpec {
  path:     string
  register: (s: McpServer) => void
}

const MODULES: ModuleSpec[] = [
  { path: '/mcp/ingest',  register: registerIngestTools  },
  { path: '/mcp/routing', register: registerRoutingTools },
  // Future: /mcp/eval when slice 60's eval module ships.
]

function createModuleServer(register: (s: McpServer) => void): McpServer {
  const s = new McpServer({ name: 'document-service', version: '1.0.0' })
  register(s)
  return s
}

export async function startServer(): Promise<void> {
  const app = express()
  app.disable('x-powered-by')
  app.use(express.json({ limit: '50mb' }))   // 58B: file payloads come through document_process

  app.get('/healthz', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'ok', service: 'document-service', slice: '58B' })
  })

  app.get('/readyz', async (_req: Request, res: Response) => {
    const checks: Record<string, 'ok' | 'fail'> = {}
    try {
      await getPool().query('SELECT 1')
      checks['db'] = 'ok'
    } catch {
      checks['db'] = 'fail'
    }
    try {
      const ok = await new ClamAVClient().ping()
      checks['clamav'] = ok ? 'ok' : 'fail'
    } catch {
      checks['clamav'] = 'fail'
    }
    const allOk = Object.values(checks).every((v) => v === 'ok')
    res.status(allOk ? 200 : 503).json({ status: allOk ? 'ok' : 'degraded', checks })
  })

  // Slice 69: per-module endpoints. Legacy /mcp removed (hard cut).
  for (const mod of MODULES) {
    app.post(mod.path, attachBearerAuth, async (req: Request, res: Response) => {
      const s = createModuleServer(mod.register)
      const transport = new StreamableHTTPServerTransport({})
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await s.connect(transport as any)
      await transport.handleRequest(req, res, req.body)
    })
  }

  return new Promise((resolve) => {
    app.listen(PORT, () => {
      console.log(`[server] document-service listening on :${PORT} (MCP modules: ${MODULES.map(m => m.path).join(', ')})`)
      resolve()
    })
  })
}
