import express, { type Express } from 'express';
import { tenantAuthMiddleware } from '@cip/shared/src/utils/tenant-context.js';
import { healthRouter } from './routes/health.js';
import { adminTenantsRouter } from './routes/admin-tenants.js';
import { authRouter } from './routes/auth.js';
import { tenantRouter } from './routes/tenant.js';
import { mountMcpServer } from './mcp-server/index.js';

export function createApp(): Express {
  const app = express();
  app.use(express.json());

  app.use(healthRouter);

  // Slice 71b fix: mount MCP routes BEFORE adminTenantsRouter. The admin
  // router's X-Platform-Admin-Token middleware uses router-level `.use()`
  // with no path prefix — that runs for every request flowing through the
  // app at this point in the chain, and was blocking GET /mcp/_modules
  // (the discovery endpoint) with 401 unauthorized. Moving MCP mounts
  // first lets unauthenticated discovery requests skip the admin gate.
  mountMcpServer(app);

  // Slice 67: POST /auth/resolve — services call this with bearer token to
  // get back AuthContext (userId, permissions, roles). Bearer auth is
  // handled inside the route, not by tenantAuthMiddleware.
  app.use(authRouter);

  // Slice 63: admin tenant endpoints (ported from hr-service). Have their
  // own X-Platform-Admin-Token middleware. Mount BEFORE tenantAuthMiddleware
  // so they bypass JWT auth (used by operators + the bot's tenant-resolver
  // which has no JWT yet at the moment it calls /admin/tenants/by-aad/...).
  app.use(adminTenantsRouter);

  app.use(tenantAuthMiddleware);
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
