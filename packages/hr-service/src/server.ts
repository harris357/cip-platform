import express, { type Express } from 'express';
import { withTenantContext } from '@cip/shared/src/utils/tenant-context.js';
import { healthRouter } from './routes/health.js';

export function createApp(): Express {
  const app = express();
  app.use(express.json());

  // Health is unauthenticated
  app.use(healthRouter);

  // All other routes require a valid tenant JWT
  app.use(withTenantContext as express.RequestHandler);

  return app;
}

export async function startServer(): Promise<void> {
  const app = createApp();
  const port = parseInt(process.env['PORT'] ?? '3000', 10);
  app.listen(port, () => {
    console.log(`HR Service listening on port ${port}`);
  });
}
