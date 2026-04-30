// Per-realm Keycloak client secrets.
//
// Slice 37 introduces a per-tenant K8s secret as the primary source: the
// tenant's `tenant_identity_providers.secret_ref` column names a K8s secret
// (e.g. tenant-aad-<tenantId>) holding KEYCLOAK_CLIENT_SECRET. The bot reads
// it via its ServiceAccount on cache miss — adding/rotating tenants requires
// no bot restart.
//
// Legacy fallbacks kept so dev keeps working without ceremony:
//   2. KEYCLOAK_CLIENT_SECRETS env JSON map: {"<realm>":"<secret>",...}
//   3. KEYCLOAK_CLIENT_SECRET single value + KEYCLOAK_REALM_FALLBACK

let _secrets: Record<string, string> | null = null;

function loadSecrets(): Record<string, string> {
  if (_secrets) return _secrets;

  const map: Record<string, string> = {};
  const raw = process.env['KEYCLOAK_CLIENT_SECRETS'] ?? '';
  if (raw) {
    try {
      Object.assign(map, JSON.parse(raw) as Record<string, string>);
    } catch {
      console.error('[kc-secrets] KEYCLOAK_CLIENT_SECRETS is set but not valid JSON — ignored');
    }
  }

  // Single-realm fallback: KEYCLOAK_CLIENT_SECRET + KEYCLOAK_REALM_FALLBACK.
  const single = process.env['KEYCLOAK_CLIENT_SECRET'] ?? '';
  const fallbackRealm = process.env['KEYCLOAK_REALM_FALLBACK'] ?? 'cip-dev';
  if (single && !map[fallbackRealm]) {
    map[fallbackRealm] = single;
  }

  _secrets = map;
  return map;
}

export function lookupKcSecret(realm: string): string | null {
  const secrets = loadSecrets();
  return secrets[realm] ?? null;
}

// Test-only helper — clears the cached map so tests can mutate env between cases.
export function _resetKcSecretsCache(): void {
  _secrets = null;
}

// Slice 37: resolve the KC client secret for a tenant in priority order.
//   1. K8s secret named in `secretRef` (production path; per-tenant)
//   2. KEYCLOAK_CLIENT_SECRETS JSON map env (legacy multi-tenant)
//   3. KEYCLOAK_CLIENT_SECRET single value + KEYCLOAK_REALM_FALLBACK
//
// Returns the secret value, or null if every path was empty.
// May throw on K8s API errors other than 404 (caller treats as
// k8s_secret_read_failed).
import { readK8sSecretValue } from './k8s-secret-loader.js';

export async function resolveKcClientSecret(
  realm: string,
  secretRef: string | null,
): Promise<string | null> {
  if (secretRef) {
    const v = await readK8sSecretValue(secretRef, 'KEYCLOAK_CLIENT_SECRET');
    if (v) return v;
    // secret_ref was set but the secret didn't exist or didn't carry the
    // KEYCLOAK_CLIENT_SECRET key — fall through to env fallbacks rather
    // than fail outright, so a half-provisioned tenant can still work
    // during dev migration.
  }
  return lookupKcSecret(realm);
}
