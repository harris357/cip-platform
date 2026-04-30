// Per-realm Keycloak client secrets.
//
// Production multi-tenant bot: pass a JSON map via KEYCLOAK_CLIENT_SECRETS env,
// e.g. {"<tenant-uuid-1>":"abc...","<tenant-uuid-2>":"def..."}.
//
// Backwards-compat for single-realm dev: set KEYCLOAK_CLIENT_SECRET (single
// value) plus KEYCLOAK_REALM_FALLBACK (defaults to 'cip-dev'). The single
// secret is registered under that fallback realm name.

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
