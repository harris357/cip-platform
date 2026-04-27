import { startServer } from './server.js';
import { startTemporalWorker } from './workers/temporal-worker.js';
import { startAmbientWatcher } from './nats/watcher.js';
import { startMcpServer } from './mcp-server/index.js';

async function main() {
  await Promise.all([
    startServer(),
    startMcpServer(),
    startTemporalWorker(),
    startAmbientWatcher(),
  ]);
}

main().catch((err) => {
  console.error('HR Service startup failed:', err);
  process.exit(1);
});
