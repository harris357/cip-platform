import { startServer } from './server.js';
import { startTemporalWorker } from './workers/temporal-worker.js';
import { startAmbientWatcher } from './nats/watcher.js';

async function main() {
  const tenantId = process.env['DEV_TENANT_ID'];
  if (!tenantId) throw new Error('DEV_TENANT_ID must be set');

  await Promise.all([
    startServer(),
    startTemporalWorker(),
    startAmbientWatcher(tenantId),
  ]);
}

main().catch((err) => {
  console.error('HR Service startup failed:', err);
  process.exit(1);
});
