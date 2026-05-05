// Slice 58A — minimal HTTP server.  Provides:
//   - GET /healthz (liveness)
//   - GET /readyz  (readiness — checks DB + clamav reachable)
//
// MCP tools are added in 58B+; the MCP transport mount is set up
// here but registers no tools yet.  This is intentional per the
// slice scope rule.

import express, { type Request, type Response } from 'express'
import { getPool } from './db/index.js'
import { ClamAVClient } from './av/clamav-client.js'

const PORT = Number(process.env['PORT'] ?? 3000)

export async function startServer(): Promise<void> {
  const app = express()
  app.disable('x-powered-by')

  app.get('/healthz', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'ok', service: 'document-service', slice: '58A' })
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

  return new Promise((resolve) => {
    app.listen(PORT, () => {
      console.log(`[server] document-service listening on :${PORT}`)
      resolve()
    })
  })
}
