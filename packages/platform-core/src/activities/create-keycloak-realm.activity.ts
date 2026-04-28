import { z } from 'zod';

const OutputSchema = z.object({ tenantId: z.string(), realm: z.string() });

export async function createKeycloakRealm(input: {
  tenantId: string;
  tenantName: string;
}): Promise<void> {
  const keycloakBase = process.env['KEYCLOAK_URL'] ?? 'http://keycloak:8080';

  // Obtain admin token via master realm client credentials
  const tokenResp = await fetch(
    `${keycloakBase}/realms/master/protocol/openid-connect/token`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'client_credentials',
        client_id:     'admin-cli',
        client_secret: process.env['KEYCLOAK_ADMIN_SECRET'] ?? '',
      }).toString(),
    },
  );
  if (!tokenResp.ok) throw new Error(`Keycloak admin token failed: ${tokenResp.status}`);
  const { access_token } = (await tokenResp.json()) as { access_token: string };

  // Create realm — realm name = tenantId (prod convention; for dev, KEYCLOAK_REALM overrides)
  const createResp = await fetch(`${keycloakBase}/admin/realms`, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${access_token}`,
    },
    body: JSON.stringify({
      realm:       input.tenantId,
      displayName: input.tenantName,
      enabled:     true,
    }),
  });

  if (!createResp.ok && createResp.status !== 409) {
    throw new Error(`createKeycloakRealm: realm creation returned ${createResp.status}`);
  }

  OutputSchema.parse({ tenantId: input.tenantId, realm: input.tenantId });
}
