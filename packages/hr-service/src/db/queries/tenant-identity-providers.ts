import type { PoolClient } from 'pg';
import {
  TenantIdentityProviderSchema,
  type TenantIdentityProvider,
} from '@cip/shared/src/types/tenant.js';

const TIP_COLUMNS = `
  id,
  tenant_id     AS "tenantId",
  provider_type AS "providerType",
  alias,
  enabled,
  config,
  secret_ref    AS "secretRef",
  created_at    AS "createdAt",
  updated_at    AS "updatedAt"
`;

function rowToProvider(row: unknown): TenantIdentityProvider {
  const r = row as Record<string, unknown>;
  return TenantIdentityProviderSchema.parse({
    id:           r['id'],
    tenantId:     r['tenantId'],
    providerType: r['providerType'],
    alias:        r['alias'],
    enabled:      r['enabled'],
    config:       (r['config'] ?? {}) as Record<string, unknown>,
    secretRef:    r['secretRef'] ?? null,
    createdAt:    (r['createdAt'] as Date | string).toString(),
    updatedAt:    (r['updatedAt'] as Date | string).toString(),
  });
}

export async function listProvidersForTenant(
  client: PoolClient,
  tenantId: string,
): Promise<TenantIdentityProvider[]> {
  const r = await client.query(
    `SELECT ${TIP_COLUMNS} FROM tenant_identity_providers
     WHERE tenant_id = $1 ORDER BY created_at`,
    [tenantId],
  );
  return r.rows.map(rowToProvider);
}

export interface AadLookupResult {
  tenant:   { id: string; status: string };
  provider: TenantIdentityProvider;
}

export async function findActiveAadTenant(
  client: PoolClient,
  aadTenantId: string,
): Promise<AadLookupResult | null> {
  const r = await client.query(
    `SELECT t.id     AS "t_id",
            t.status AS "t_status",
            tip.id, tip.tenant_id AS "tenantId", tip.provider_type AS "providerType",
            tip.alias, tip.enabled, tip.config, tip.secret_ref AS "secretRef",
            tip.created_at AS "createdAt", tip.updated_at AS "updatedAt"
     FROM tenants t
     JOIN tenant_identity_providers tip ON tip.tenant_id = t.id
     WHERE tip.provider_type = 'aad_oidc'
       AND tip.config->>'aad_tenant_id' = $1
       AND tip.enabled = true
       AND t.status = 'active'
     LIMIT 1`,
    [aadTenantId],
  );
  if (!r.rows[0]) return null;
  const row = r.rows[0] as Record<string, unknown>;
  return {
    tenant:   { id: row['t_id'] as string, status: row['t_status'] as string },
    provider: rowToProvider(row),
  };
}

export async function insertProvider(
  client: PoolClient,
  input: {
    tenantId:      string;
    providerType:  string;
    alias:         string;
    config:        Record<string, unknown>;
    secretRef?:    string;
    enabled?:      boolean;
  },
): Promise<TenantIdentityProvider> {
  const r = await client.query(
    `INSERT INTO tenant_identity_providers
       (tenant_id, provider_type, alias, enabled, config, secret_ref)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)
     RETURNING ${TIP_COLUMNS}`,
    [
      input.tenantId,
      input.providerType,
      input.alias,
      input.enabled ?? true,
      JSON.stringify(input.config),
      input.secretRef ?? null,
    ],
  );
  return rowToProvider(r.rows[0]);
}
