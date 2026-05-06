import { eq, and, sql } from 'drizzle-orm'
import {
  TenantIdentityProviderSchema,
  type TenantIdentityProvider,
} from '@cip/shared/src/types/tenant.js'
import type { Db } from '../index.js'
import { tenantIdentityProviders, tenants } from '../schema.js'

// Slice 63: drizzle-based identity-provider queries against
// cip_platform.tenant_identity_providers. Replaces hr-service/src/db/queries/
// tenant-identity-providers.ts (deleted in this slice).

function rowToProvider(row: typeof tenantIdentityProviders.$inferSelect): TenantIdentityProvider {
  return TenantIdentityProviderSchema.parse({
    id:           row.id,
    tenantId:     row.tenantId,
    providerType: row.providerType,
    alias:        row.alias,
    enabled:      row.enabled,
    config:       (row.config ?? {}) as Record<string, unknown>,
    secretRef:    row.secretRef ?? null,
    createdAt:    row.createdAt.toString(),
    updatedAt:    row.updatedAt.toString(),
  })
}

export async function listProvidersForTenant(
  db: Db,
  tenantId: string,
): Promise<TenantIdentityProvider[]> {
  const rows = await db
    .select()
    .from(tenantIdentityProviders)
    .where(eq(tenantIdentityProviders.tenantId, tenantId))
    .orderBy(tenantIdentityProviders.createdAt)
  return rows.map(rowToProvider)
}

export interface AadLookupResult {
  tenant:   { id: string; status: string; realm: string }
  provider: TenantIdentityProvider
}

export async function findActiveAadTenant(
  db: Db,
  aadTenantId: string,
): Promise<AadLookupResult | null> {
  const rows = await db
    .select({
      tenantId:     tenants.id,
      tenantStatus: tenants.status,
      tenantRealm:  tenants.realm,
      provider:     tenantIdentityProviders,
    })
    .from(tenants)
    .innerJoin(
      tenantIdentityProviders,
      eq(tenantIdentityProviders.tenantId, tenants.id),
    )
    .where(
      and(
        eq(tenantIdentityProviders.providerType, 'aad_oidc'),
        sql`${tenantIdentityProviders.config}->>'aad_tenant_id' = ${aadTenantId}`,
        eq(tenantIdentityProviders.enabled, true),
        eq(tenants.status, 'active'),
      ),
    )
    .limit(1)
  const row = rows[0]
  if (!row) return null
  return {
    tenant: {
      id:     row.tenantId,
      status: row.tenantStatus,
      realm:  row.tenantRealm,
    },
    provider: rowToProvider(row.provider),
  }
}

export interface InsertProviderInput {
  tenantId:     string
  providerType: string
  alias:        string
  config:       Record<string, unknown>
  secretRef?:   string
  enabled?:     boolean
}

export async function insertProvider(
  db: Db,
  input: InsertProviderInput,
): Promise<TenantIdentityProvider> {
  const rows = await db
    .insert(tenantIdentityProviders)
    .values({
      tenantId:     input.tenantId,
      providerType: input.providerType,
      alias:        input.alias,
      enabled:      input.enabled ?? true,
      config:       input.config,
      secretRef:    input.secretRef ?? null,
    })
    .returning()
  return rowToProvider(rows[0]!)
}
