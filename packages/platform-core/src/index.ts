import { startServer } from './server.js';
import { startTemporalWorker } from './workers/temporal-worker.js';

async function main() {
  await Promise.all([
    startServer(),
    startTemporalWorker(),
  ]);
}

main().catch((err) => {
  console.error('Platform Core startup failed:', err);
  process.exit(1);
});
