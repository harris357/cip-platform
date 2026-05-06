import express, { type Express } from 'express';
import { tenantAuthMiddleware } from '@cip/shared/src/utils/tenant-context.js';
import { healthRouter } from './routes/health.js';
import { adminTenantsRouter } from './routes/admin-tenants.js';
import { tenantRouter } from './routes/tenant.js';
import { mountMcpServer } from './mcp-server/index.js';

export function createApp(): Express {
  const app = express();
  app.use(express.json());

  app.use(healthRouter);

  // Slice 63: admin tenant endpoints (ported from hr-service). Have their
  // own X-Platform-Admin-Token middleware. Mount BEFORE tenantAuthMiddleware
  // so they bypass JWT auth (used by operators + the bot's tenant-resolver
  // which has no JWT yet at the moment it calls /admin/tenants/by-aad/...).
  app.use(adminTenantsRouter);

  // Slice 66: MCP server at /mcp/platform. Bearer-token authenticated;
  // each POST builds a fresh McpServer + transport for per-request auth
  // isolation. Sits before tenantAuthMiddleware (it owns its own bearer
  // extraction).
  mountMcpServer(app);

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
