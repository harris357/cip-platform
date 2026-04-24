import express, { type Express } from 'express';
import { withTenantContext } from '@cip/shared/src/utils/tenant-context.js';
import { healthRouter } from './routes/health.js';
import { tenantRouter } from './routes/tenant.js';

export function createApp(): Express {
  const app = express();
  app.use(express.json());

  app.use(healthRouter);

  app.use(withTenantContext as express.RequestHandler);
  app.use(tenantRouter);

  return app;
}

export async function startServer(): Promise<void> {
  const app = createApp();
  const port = parseInt(process.env['PORT'] ?? '3001', 10);
  app.listen(port, () => {
    console.log(`Platform Core listening on port ${port}`);
  });
}
