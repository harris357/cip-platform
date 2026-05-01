import express, { type Express } from 'express';
import { tenantAuthMiddleware } from '@cip/shared/src/utils/tenant-context.js';
import { healthRouter } from './routes/health.js';
import { adminTenantsRouter } from './routes/admin-tenants.js';
import { adminEmployeesRouter } from './routes/admin-employees.js';
import { adminRoutingRouter } from './routes/admin-routing.js';
import { adminToolRetrievalRouter } from './routes/admin-tool-retrieval.js';

export function createApp(): Express {
  const app = express();
  app.use(express.json());

  // Health is unauthenticated
  app.use(healthRouter);

  // Admin tenants endpoints are platform-scoped (no tenant in URL); they
  // have their own X-Platform-Admin-Token middleware. Mount BEFORE the
  // tenant JWT middleware so they bypass it.
  app.use(adminTenantsRouter);

  // Slice 39A: routing rules read by the bot's alias-resolver. Same
  // platform-admin token, mounted before the tenant JWT middleware.
  app.use(adminRoutingRouter);

  // Slice 44: tool-retrieval endpoint called by the bot's discoverTools
  // to narrow the LLM-visible tool set via vector similarity. Same
  // platform-admin token; mounted before the tenant JWT middleware.
  app.use(adminToolRetrievalRouter);

  // All other routes require a valid tenant JWT
  app.use(tenantAuthMiddleware);

  // Slice 31: tenant-scoped admin employee provisioning. Goes after the
  // tenant JWT middleware so requireRealmRole('hr') can read req.tenantContext.roles.
  app.use(adminEmployeesRouter);

  return app;
}

export async function startServer(): Promise<void> {
  const app = createApp();
  const port = parseInt(process.env['PORT'] ?? '3000', 10);
  app.listen(port, () => {
    console.log(`HR Service listening on port ${port}`);
  });
}
