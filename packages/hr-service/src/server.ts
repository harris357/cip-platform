import express, { type Express } from 'express';
import { tenantAuthMiddleware } from '@cip/shared/src/utils/tenant-context.js';
import { healthRouter } from './routes/health.js';
import { adminEmployeesRouter } from './routes/admin-employees.js';
import { adminRoutingRouter } from './routes/admin-routing.js';
import { adminToolRetrievalRouter } from './routes/admin-tool-retrieval.js';
import { adminBotTunablesRouter } from './routes/admin-bot-tunables.js';
import { adminToolMetadataRouter } from './routes/admin-tool-metadata.js';
import { internalResolutionsRouter } from './routes/internal-resolutions.js';

export function createApp(): Express {
  const app = express();
  app.use(express.json());

  // Health is unauthenticated
  app.use(healthRouter);

  // Slice 63: adminTenantsRouter moved to platform-core. The bot's tenant
  // resolver and any operator scripts now hit platform-core directly.

  // Slice 39A: routing rules read by the bot's alias-resolver. Same
  // platform-admin token, mounted before the tenant JWT middleware.
  // (Slice 63: queries now do cross-schema reads against cip_platform.routing_rules.)
  app.use(adminRoutingRouter);

  // Slice 58D-A: person_match_resolutions lookup for the bot's
  // hr-person-pick invoke handler. Same platform-admin token; mounted
  // before the tenant JWT middleware.
  app.use(internalResolutionsRouter);

  // Slice 44: tool-retrieval endpoint called by the bot's discoverTools
  // to narrow the LLM-visible tool set via vector similarity. Same
  // platform-admin token; mounted before the tenant JWT middleware.
  app.use(adminToolRetrievalRouter);

  // Slice 45: bot_tunables endpoint — runtime-tunable thresholds for the
  // LangGraph runtime. Per-tenant overrides shadow global defaults. Same
  // platform-admin token; mounted before the tenant JWT middleware.
  app.use(adminBotTunablesRouter);

  // Hotfix (post-Slice 46): the MCP SDK strips non-spec annotation fields
  // on the wire, so the bot can't see sideEffectLevel/requiredPermission/
  // whenToUse/whenNotToUse via listTools(). This endpoint exposes the
  // server's internal registry directly so the bot can merge metadata
  // back in. Same platform-admin token.
  app.use(adminToolMetadataRouter);

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
