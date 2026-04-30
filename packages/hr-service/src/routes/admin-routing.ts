import { Router, type IRouter, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { getPool } from '../db/index.js';
import {
  listRoutingRulesByService,
  getTenantRoutingOverrides,
} from '../db/queries/routing-rules.js';

export const adminRoutingRouter: IRouter = Router();

// Same shared-token auth as admin-tenants — keeps platform-admin endpoints uniform.
adminRoutingRouter.use((req: Request, res: Response, next: NextFunction): void => {
  const expected = process.env['PLATFORM_ADMIN_TOKEN'] ?? '';
  const got = req.header('x-platform-admin-token') ?? '';
  if (!expected || expected !== got) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
});

const ServiceSchema = z.enum(['bot', 'hr-service', 'platform-core']);

adminRoutingRouter.get(
  '/admin/routing-rules',
  async (req: Request, res: Response): Promise<void> => {
    const serviceParse = ServiceSchema.safeParse(req.query['service']);
    if (!serviceParse.success) {
      res.status(400).json({ error: 'service_required', allowed: ServiceSchema.options });
      return;
    }
    const service = serviceParse.data;

    const tenantIdRaw = req.query['tenantId'];
    const tenantId = typeof tenantIdRaw === 'string' && tenantIdRaw.length > 0 ? tenantIdRaw : null;

    const pool = getPool();
    const client = await pool.connect();
    try {
      const rules = await listRoutingRulesByService(client, service);
      let overrides: Record<string, string> = {};
      if (tenantId) {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantId]);
        overrides = await getTenantRoutingOverrides(client, tenantId);
        await client.query('COMMIT');
      }
      res.json({ rules, overrides });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      console.error('[admin-routing] failed:', err);
      res.status(500).json({ error: 'internal' });
    } finally {
      client.release();
    }
  },
);
