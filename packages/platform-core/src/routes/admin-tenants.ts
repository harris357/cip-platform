import { Router, type IRouter, type Request, type Response, type NextFunction } from 'express'
import { z } from 'zod'
import { getDb } from '../db/index.js'
import { listTenants, findTenantById } from '../db/queries/tenants.js'
import {
  listProvidersForTenant,
  findActiveAadTenant,
} from '../db/queries/tenant-identity-providers.js'
import {
  TenantTierSchema,
  IdentityProviderTypeSchema,
} from '@cip/shared/src/types/tenant.js'
import { createTenantWithProviders } from '../services/tenant-provisioning.js'

// Slice 63: ported from hr-service/src/routes/admin-tenants.ts. Same
// X-Platform-Admin-Token guard, same 4 endpoints, same response shapes.
// Now reads/writes cip_platform.* directly via drizzle.

export const adminTenantsRouter: IRouter = Router()

// Simple shared-token auth: replaced with proper platform-admin role in a
// future slice when there's a master/platform realm in KC (D8 → follow-up).
adminTenantsRouter.use((req: Request, res: Response, next: NextFunction): void => {
  const expected = process.env['PLATFORM_ADMIN_TOKEN'] ?? ''
  const got = req.header('x-platform-admin-token') ?? ''
  if (!expected || expected !== got) {
    res.status(401).json({ error: 'unauthorized' })
    return
  }
  next()
})

const CreateTenantSchema = z.object({
  displayName: z.string().min(1),
  adminEmail:  z.string().email(),
  tier:        TenantTierSchema.optional(),
  identityProviders: z.array(z.object({
    providerType: IdentityProviderTypeSchema,
    alias:        z.string().min(1),
    config:       z.record(z.unknown()).default({}),
    secretRef:    z.string().optional(),
    enabled:      z.boolean().optional(),
  })).default([]),
})

adminTenantsRouter.post('/admin/tenants', async (req: Request, res: Response): Promise<void> => {
  const parse = CreateTenantSchema.safeParse(req.body)
  if (!parse.success) {
    res.status(400).json({ error: 'validation', issues: parse.error.issues })
    return
  }

  try {
    const result = await createTenantWithProviders({
      displayName: parse.data.displayName,
      adminEmail:  parse.data.adminEmail,
      ...(parse.data.tier !== undefined ? { tier: parse.data.tier } : {}),
      // Map zod-parsed providers to the service input shape, dropping
      // undefined fields so they satisfy exactOptionalPropertyTypes.
      identityProviders: parse.data.identityProviders.map(idp => ({
        providerType: idp.providerType,
        alias:        idp.alias,
        config:       idp.config,
        ...(idp.secretRef !== undefined ? { secretRef: idp.secretRef } : {}),
        ...(idp.enabled   !== undefined ? { enabled:   idp.enabled }   : {}),
      })),
    })
    res.status(201).json(result)
  } catch (err) {
    console.error('[admin-tenants] create failed:', err)
    res.status(500).json({ error: 'internal' })
  }
})

adminTenantsRouter.get('/admin/tenants', async (_req: Request, res: Response): Promise<void> => {
  try {
    res.json({ tenants: await listTenants(getDb()) })
  } catch (err) {
    console.error('[admin-tenants] list failed:', err)
    res.status(500).json({ error: 'internal' })
  }
})

adminTenantsRouter.get('/admin/tenants/:id', async (req: Request, res: Response): Promise<void> => {
  const id = req.params['id']
  if (!id) { res.status(400).json({ error: 'id_required' }); return }
  try {
    const db = getDb()
    const tenant = await findTenantById(db, id)
    if (!tenant) { res.status(404).json({ error: 'not_found' }); return }
    const idps = await listProvidersForTenant(db, tenant.id)
    res.json({ tenant, identityProviders: idps })
  } catch (err) {
    console.error('[admin-tenants] fetch failed:', err)
    res.status(500).json({ error: 'internal' })
  }
})

// Hot path: bot's tenant-resolver calls this on every Teams message.
// Returns 404 when no active tenant matches; bot rejects the message.
adminTenantsRouter.get(
  '/admin/tenants/by-aad/:aadTenantId',
  async (req: Request, res: Response): Promise<void> => {
    const aadTenantId = req.params['aadTenantId']
    if (!aadTenantId) { res.status(400).json({ error: 'aad_tenant_id_required' }); return }
    try {
      const result = await findActiveAadTenant(getDb(), aadTenantId)
      if (!result) { res.status(404).json({ error: 'not_found' }); return }
      res.json(result)
    } catch (err) {
      console.error('[admin-tenants] by-aad lookup failed:', err)
      res.status(500).json({ error: 'internal' })
    }
  },
)
