// Slice 45: bot tunables endpoint. Mirror of /admin/routing-rules pattern —
// shared platform-admin token auth, mounted before tenant JWT middleware.
//
// Bot calls this on every cache miss (5-minute TTL) to fetch the merged
// global + per-tenant tunable map for the calling tenant.

import { Router, type IRouter, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { getPool } from '../db/index.js';
import { getBotTunables } from '../db/queries/bot-tunables.js';

export const adminBotTunablesRouter: IRouter = Router();

adminBotTunablesRouter.use((req: Request, res: Response, next: NextFunction): void => {
  const expected = process.env['PLATFORM_ADMIN_TOKEN'] ?? '';
  const got = req.header('x-platform-admin-token') ?? '';
  if (!expected || expected !== got) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
});

const QuerySchema = z.object({
  tenantId: z.string().uuid(),
});

adminBotTunablesRouter.get(
  '/admin/bot-tunables',
  async (req: Request, res: Response): Promise<void> => {
    const parsed = QuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'tenantId_required' });
      return;
    }
    const { tenantId } = parsed.data;

    const pool = getPool();
    const client = await pool.connect();
    try {
      const tunables = await getBotTunables(client, tenantId);
      res.json({ tunables });
    } catch (err) {
      console.error('[admin-bot-tunables] failed:', err);
      res.status(500).json({ error: 'internal' });
    } finally {
      client.release();
    }
  },
);
