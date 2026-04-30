import express, { type Express } from 'express';
import { tenantAuthMiddleware } from '@cip/shared/src/utils/tenant-context.js';
import { healthRouter } from './routes/health.js';
import { adminTenantsRouter } from './routes/admin-tenants.js';

export function createApp(): Express {
  const app = express();
  app.use(express.json());

  // Health is unauthenticated
  app.use(healthRouter);

  // Admin tenants endpoints are platform-scoped (no tenant in URL); they
  // have their own X-Platform-Admin-Token middleware. Mount BEFORE the
  // tenant JWT middleware so they bypass it.
  app.use(adminTenantsRouter);

  // All other routes require a valid tenant JWT
  app.use(tenantAuthMiddleware);

  return app;
}

export async function startServer(): Promise<void> {
  const app = createApp();
  const port = parseInt(process.env['PORT'] ?? '3000', 10);
  app.listen(port, () => {
    console.log(`HR Service listening on port ${port}`);
  });
}
