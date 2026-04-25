import { startServer } from './server.js';
import { startTemporalWorker } from './workers/temporal-worker.js';
import { startAmbientWatcher } from './nats/watcher.js';

async function main() {
  await Promise.all([
    startServer(),
    startTemporalWorker(),
    startAmbientWatcher(),
  ]);
}

main().catch((err) => {
  console.error('HR Service startup failed:', err);
  process.exit(1);
});
