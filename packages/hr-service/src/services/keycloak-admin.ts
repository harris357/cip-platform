// Slice 33: shared helpers for KC admin-API calls used by employee
// activities (federation attach/detach, credentials clear, OTP setup,
// session invalidation, user disable). Keeps the service-account token
// fetch in one place so each activity doesn't reimplement it.

const KC_BASE = process.env['KEYCLOAK_URL'] ?? 'http://keycloak:8080';

export function getKcRealm(tenantId: string): string {
  // Dev: a single shared realm overrides per-tenant naming.
  // Prod: realm = tenantId (matches the prod model from architecture doc).
  return process.env['KEYCLOAK_REALM'] ?? tenantId;
}

/**
 * Obtain a service-account access token for the hr-service KC client.
 * Used as Authorization for all admin REST calls below.
 */
export async function getServiceAccountToken(realm: string): Promise<string> {
  const clientId     = process.env['KEYCLOAK_CLIENT_ID']     ?? 'hr-service';
  const clientSecret = process.env['KEYCLOAK_CLIENT_SECRET'] ?? '';
  const url = `${KC_BASE}/realms/${realm}/protocol/openid-connect/token`;
  const resp = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'client_credentials',
      client_id:     clientId,
      client_secret: clientSecret,
    }).toString(),
  });
  if (!resp.ok) throw new Error(`Keycloak service account token failed: ${resp.status}`);
  const data = (await resp.json()) as { access_token?: string };
  if (!data.access_token) throw new Error('Keycloak service account: no access_token in response');
  return data.access_token;
}

export interface KcAdmin {
  realm: string;
  token: string;
  base:  string;
}

export async function getKcAdmin(tenantId: string): Promise<KcAdmin> {
  const realm = getKcRealm(tenantId);
  const token = await getServiceAccountToken(realm);
  return { realm, token, base: KC_BASE };
}

export async function kcAdminRequest(
  admin: KcAdmin,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<Response> {
  const init: RequestInit = {
    method,
    headers: {
      'Authorization': `Bearer ${admin.token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };
  return fetch(`${admin.base}/admin/realms/${admin.realm}${path}`, init);
}
