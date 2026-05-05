// Slice 58A — document-service entrypoint.
//
// Brings up the HTTP server (healthz + future MCP transport) and
// the Temporal worker.  No MCP tools registered in 58A — 58B onward
// fills them in.  No activities registered in the worker yet either;
// 58B adds the first ones.

import { startServer } from './server.js'
import { startTemporalWorker } from './workers/temporal-worker.js'

async function main(): Promise<void> {
  await startServer()
  // Worker runs in the background.  startTemporalWorker resolves once the
  // worker starts polling; the worker itself runs forever.
  startTemporalWorker().catch((err) => {
    console.error('[temporal-worker] fatal', err)
    process.exit(1)
  })
}

main().catch((err) => {
  console.error('[document-service] fatal', err)
  process.exit(1)
})
