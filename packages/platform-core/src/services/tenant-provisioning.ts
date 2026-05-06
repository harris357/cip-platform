import { randomUUID } from 'node:crypto'
import type {
  Tenant,
  TenantIdentityProvider,
  TenantTier,
  IdentityProviderType,
} from '@cip/shared/src/types/tenant.js'
import { getDb } from '../db/index.js'
import { insertTenant } from '../db/queries/tenants.js'
import { insertProvider } from '../db/queries/tenant-identity-providers.js'

// Slice 63: shared service used by both POST /admin/tenants (admin row
// creation only) and POST /tenants (row creation + workflow kickoff).
// One transactional path; route layer decides whether to start a workflow.

export interface CreateTenantInput {
  displayName: string
  adminEmail:  string
  tier?:       TenantTier
  identityProviders?: Array<{
    providerType: IdentityProviderType
    alias:        string
    config?:      Record<string, unknown>
    secretRef?:   string
    enabled?:     boolean
  }>
  /** Pre-allocated tenant id; useful when the caller wants to predict the workflow id. */
  id?: string
}

export interface CreateTenantResult {
  tenant:            Tenant
  identityProviders: TenantIdentityProvider[]
}

export async function createTenantWithProviders(
  input: CreateTenantInput,
): Promise<CreateTenantResult> {
  const id = input.id ?? randomUUID()
  const db = getDb()

  return db.transaction(async (tx) => {
    const tenant = await insertTenant(tx, {
      id,
      displayName: input.displayName,
      adminEmail:  input.adminEmail,
      tier:        input.tier ?? 'standard',
    })

    const providers: TenantIdentityProvider[] = []
    for (const idp of input.identityProviders ?? []) {
      providers.push(
        await insertProvider(tx, {
          tenantId:     id,
          providerType: idp.providerType,
          alias:        idp.alias,
          config:       idp.config ?? {},
          ...(idp.secretRef !== undefined ? { secretRef: idp.secretRef } : {}),
          ...(idp.enabled   !== undefined ? { enabled:   idp.enabled }   : {}),
        }),
      )
    }

    return { tenant, identityProviders: providers }
  })
}
