import { Router, type IRouter, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { getPool } from '../db/index.js';
import {
  insertTenant,
  listTenants,
  findTenantById,
} from '../db/queries/tenants.js';
import {
  insertProvider,
  listProvidersForTenant,
  findActiveAadTenant,
} from '../db/queries/tenant-identity-providers.js';
import {
  TenantTierSchema,
  IdentityProviderTypeSchema,
} from '@cip/shared/src/types/tenant.js';

export const adminTenantsRouter: IRouter = Router();

// Simple shared-token auth: replace with proper platform-admin role in a
// future slice when there's a master/platform realm in KC.
adminTenantsRouter.use((req: Request, res: Response, next: NextFunction): void => {
  const expected = process.env['PLATFORM_ADMIN_TOKEN'] ?? '';
  const got = req.header('x-platform-admin-token') ?? '';
  if (!expected || expected !== got) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
});

const CreateTenantSchema = z.object({
  displayName:   z.string().min(1),
  adminEmail:    z.string().email(),
  tier:          TenantTierSchema.optional(),
  identityProviders: z.array(z.object({
    providerType: IdentityProviderTypeSchema,
    alias:        z.string().min(1),
    config:       z.record(z.unknown()).default({}),
    secretRef:    z.string().optional(),
    enabled:      z.boolean().optional(),
  })).default([]),
});

adminTenantsRouter.post('/admin/tenants', async (req: Request, res: Response): Promise<void> => {
  const parse = CreateTenantSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: 'validation', issues: parse.error.issues });
    return;
  }

  const id = randomUUID();
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tenant = await insertTenant(client, {
      id,
      displayName: parse.data.displayName,
      adminEmail:  parse.data.adminEmail,
      tier:        parse.data.tier ?? 'standard',
    });
    const providers = [];
    for (const idp of parse.data.identityProviders) {
      providers.push(await insertProvider(client, {
        tenantId:     id,
        providerType: idp.providerType,
        alias:        idp.alias,
        config:       idp.config,
        ...(idp.secretRef        !== undefined ? { secretRef: idp.secretRef } : {}),
        ...(idp.enabled          !== undefined ? { enabled:   idp.enabled }   : {}),
      }));
    }
    await client.query('COMMIT');
    res.status(201).json({ tenant, identityProviders: providers });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[admin-tenants] create failed:', err);
    res.status(500).json({ error: 'internal' });
  } finally {
    client.release();
  }
});

adminTenantsRouter.get('/admin/tenants', async (_req: Request, res: Response): Promise<void> => {
  const pool = getPool();
  const client = await pool.connect();
  try {
    res.json({ tenants: await listTenants(client) });
  } finally {
    client.release();
  }
});

adminTenantsRouter.get('/admin/tenants/:id', async (req: Request, res: Response): Promise<void> => {
  const id = req.params['id'];
  if (!id) { res.status(400).json({ error: 'id_required' }); return; }
  const pool = getPool();
  const client = await pool.connect();
  try {
    const tenant = await findTenantById(client, id);
    if (!tenant) { res.status(404).json({ error: 'not_found' }); return; }
    const idps = await listProvidersForTenant(client, tenant.id);
    res.json({ tenant, identityProviders: idps });
  } finally {
    client.release();
  }
});

// Lookup endpoint used by the bot in Slice 36.
// Returns 404 if no active tenant matches; bot rejects the message in that case.
adminTenantsRouter.get(
  '/admin/tenants/by-aad/:aadTenantId',
  async (req: Request, res: Response): Promise<void> => {
    const aadTenantId = req.params['aadTenantId'];
    if (!aadTenantId) { res.status(400).json({ error: 'aad_tenant_id_required' }); return; }
    const pool = getPool();
    const client = await pool.connect();
    try {
      const result = await findActiveAadTenant(client, aadTenantId);
      if (!result) { res.status(404).json({ error: 'not_found' }); return; }
      res.json(result);
    } finally {
      client.release();
    }
  },
);
