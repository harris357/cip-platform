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

function createRegisteredServer(): McpServer {
  const s = new McpServer({ name: 'document-service', version: '1.0.0' })
  registerIngestTools(s)
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

  // Stateless MCP — each POST gets its own server + transport so the
  // Authorization header context is per-request. Mirrors hr-service.
  app.post('/mcp', attachBearerAuth, async (req: Request, res: Response) => {
    const s = createRegisteredServer()
    const transport = new StreamableHTTPServerTransport({})
    // SDK transport.onclose typed as required even though it's not — the
    // cast keeps exactOptionalPropertyTypes-compliant call sites happy.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await s.connect(transport as any)
    await transport.handleRequest(req, res, req.body)
  })

  return new Promise((resolve) => {
    app.listen(PORT, () => {
      console.log(`[server] document-service listening on :${PORT} (MCP at POST /mcp)`)
      resolve()
    })
  })
}
