// Slice 71: KC admin token helper. Used by every KC-touching activity.
// Mirrors the inline pattern in createKeycloakRealm so all activities share
// one token-fetch path.

export async function getKeycloakAdminToken(): Promise<{
  token:        string
  keycloakBase: string
}> {
  const keycloakBase = (process.env['KEYCLOAK_URL'] ?? 'http://keycloak:8080').replace(/\/$/, '')
  const adminSecret  = process.env['KEYCLOAK_ADMIN_SECRET'] ?? ''
  if (!adminSecret) throw new Error('KEYCLOAK_ADMIN_SECRET not set')

  const resp = await fetch(
    `${keycloakBase}/realms/master/protocol/openid-connect/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'client_credentials',
        client_id:     'admin-cli',
        client_secret: adminSecret,
      }).toString(),
    },
  )
  if (!resp.ok) throw new Error(`Keycloak admin token failed: HTTP ${resp.status}`)
  const { access_token } = (await resp.json()) as { access_token: string }
  return { token: access_token, keycloakBase }
}

export async function kcAdminFetch(
  base:  string,
  token: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path:  string,
  body?: unknown,
): Promise<Response> {
  return fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${token}`,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}
