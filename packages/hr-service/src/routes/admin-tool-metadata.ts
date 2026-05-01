// Critical bug fix: the MCP SDK's listTools() strips non-spec fields from
// `annotations`, so the bot never sees `sideEffectLevel`, `requiredPermission`,
// `whenToUse`, `whenNotToUse`, `commonNextTools`, or `outputSchema` — the
// metadata Slice 45 relies on for the write-confirm gate, the permission
// filter, and the planner's tool reference block.
//
// Side channel: this endpoint reads the same internal _registeredTools map
// that the MCP server's listTools handler reads, but returns the FULL
// annotations object without going through MCP serialization. The bot
// fetches once per pod (annotations are static for a given image) and
// merges into discoverTools' result.
//
// Same platform-admin auth as /admin/bot-tunables and /admin/routing-rules.

import { Router, type IRouter, type Request, type Response, type NextFunction } from 'express';
import { server } from '../mcp-server/index.js';

export const adminToolMetadataRouter: IRouter = Router();

adminToolMetadataRouter.use((req: Request, res: Response, next: NextFunction): void => {
  const expected = process.env['PLATFORM_ADMIN_TOKEN'] ?? '';
  const got = req.header('x-platform-admin-token') ?? '';
  if (!expected || expected !== got) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
});

adminToolMetadataRouter.get(
  '/admin/tool-metadata',
  (_req: Request, res: Response): void => {
    // McpServer's internal registry. The SDK doesn't expose a typed accessor;
    // _registeredTools is a Record<toolName, RegisteredTool>. Cast at the
    // boundary; re-verify shape if the SDK is upgraded.
    const internal = (server as unknown as {
      _registeredTools: Record<string, { annotations?: Record<string, unknown> }>;
    })._registeredTools;

    const out: Record<string, Record<string, unknown>> = {};
    for (const [name, entry] of Object.entries(internal ?? {})) {
      out[name] = entry.annotations ?? {};
    }
    res.json({ tools: out });
  },
);
