// Resolve an AAD tenant ID (from Teams activity.channelData.tenant.id) to a
// CIP tenant context: { aadTenantId, cipTenantId, realm, kcClientSecret }.
//
// Calls hr-service GET /admin/tenants/by-aad/:aadTenantId (Slice 35) with a
// 5-minute in-memory cache keyed by AAD tenant ID. Returns either a
// TenantContext or a structured { error } describing which check failed.
//
// EVERY incoming Teams activity (message + signin/tokenExchange) goes through
// this BEFORE any token-exchange or MCP call. A failure here drops the
// request with a [security] log line — defense in depth #1.

import { resolveKcClientSecret } from './keycloak-secrets.js';

export interface TenantContext {
  aadTenantId:    string;
  cipTenantId:    string;   // === realm name
  realm:          string;
  kcClientSecret: string;
}

export type ResolveError =
  | 'no_aad_tenant_id'
  | 'platform_admin_token_unset'
  | 'unknown_tenant'
  | 'inactive_tenant'
  | 'wrong_provider_type'
  | 'provider_disabled'
  | 'missing_kc_client_secret'
  | 'k8s_secret_not_found'
  | 'k8s_secret_read_failed'
  | `lookup_failed_${number}`;

export type ResolveResult = TenantContext | { error: ResolveError };

interface CacheEntry {
  ctx:       TenantContext;
  expiresAt: number;
}

const TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, CacheEntry>();

interface LookupResponse {
  tenant: { id: string; status: string; realm: string };
  provider: {
    id:           string;
    tenantId:     string;
    providerType: string;
    alias:        string;
    enabled:      boolean;
    config:       Record<string, unknown>;
    secretRef:    string | null;
  };
}

export async function resolveTenantContext(aadTenantId: string): Promise<ResolveResult> {
  if (!aadTenantId) return { error: 'no_aad_tenant_id' };

  const cached = cache.get(aadTenantId);
  if (cached && Date.now() < cached.expiresAt) return cached.ctx;

  const hrUrl      = process.env['HR_SERVICE_URL']       ?? 'http://hr-service.cip-app.svc.cluster.local:3000';
  const adminToken = process.env['PLATFORM_ADMIN_TOKEN'] ?? '';
  if (!adminToken) return { error: 'platform_admin_token_unset' };

  const resp = await fetch(
    `${hrUrl}/admin/tenants/by-aad/${encodeURIComponent(aadTenantId)}`,
    { headers: { 'X-Platform-Admin-Token': adminToken } },
  );
  if (resp.status === 404) return { error: 'unknown_tenant' };
  if (!resp.ok) return { error: `lookup_failed_${resp.status}` as ResolveError };

  const data = (await resp.json()) as LookupResponse;
  if (data.tenant.status !== 'active')           return { error: 'inactive_tenant' };
  if (data.provider.providerType !== 'aad_oidc') return { error: 'wrong_provider_type' };
  if (!data.provider.enabled)                    return { error: 'provider_disabled' };

  // tenant.realm is the KC realm name (defaults to id::text for prod;
  // override in DB for dev where one shared realm serves the test tenant).
  const realm = data.tenant.realm;
  let kcClientSecret: string | null = null;
  try {
    kcClientSecret = await resolveKcClientSecret(realm, data.provider.secretRef);
  } catch (err) {
    console.error(`[security] k8s secret read failed: realm=${realm} secret_ref=${data.provider.secretRef}`, err);
    return { error: 'k8s_secret_read_failed' };
  }
  if (!kcClientSecret) {
    // secret_ref pointed at a non-existent K8s secret AND no env fallback had a value.
    return { error: data.provider.secretRef ? 'k8s_secret_not_found' : 'missing_kc_client_secret' };
  }

  const ctx: TenantContext = {
    aadTenantId,
    cipTenantId: data.tenant.id,
    realm,
    kcClientSecret,
  };
  cache.set(aadTenantId, { ctx, expiresAt: Date.now() + TTL_MS });
  return ctx;
}

// Test-only helper.
export function _resetTenantCache(): void {
  cache.clear();
}
