import { z } from 'zod';

type IdentityType = 'aad_federated' | 'field_employee';

export interface CreateKeycloakUserInput {
  tenantId:     string;
  employeeId:   string;
  identityType: IdentityType;
  email:        string;
  fullName:     string;
  aadOid?:      string;
}

export interface CreateKeycloakUserOutput {
  keycloakId: string;
}

const CreateKeycloakUserOutputSchema = z.object({
  keycloakId: z.string().min(1),
});

async function getServiceAccountToken(realm: string): Promise<string> {
  const keycloakBase = process.env['KEYCLOAK_URL'] ?? 'http://keycloak:8080';
  const clientId     = process.env['KEYCLOAK_CLIENT_ID'] ?? 'hr-service';
  const clientSecret = process.env['KEYCLOAK_CLIENT_SECRET'] ?? '';
  const url = `${keycloakBase}/realms/${realm}/protocol/openid-connect/token`;

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

export async function createKeycloakUserActivity(
  input: CreateKeycloakUserInput,
): Promise<CreateKeycloakUserOutput> {
  const keycloakBase = process.env['KEYCLOAK_URL'] ?? 'http://keycloak:8080';
  // For dev, realm = KEYCLOAK_REALM. In prod, realm = tenantId (see Slice 27 reconciliation note).
  const realm = process.env['KEYCLOAK_REALM'] ?? input.tenantId;
  const token = await getServiceAccountToken(realm);
  const createUrl = `${keycloakBase}/admin/realms/${realm}/users`;

  let userPayload: object;
  if (input.identityType === 'aad_federated') {
    userPayload = {
      username:            input.email,
      email:               input.email,
      firstName:           input.fullName.split(' ')[0] ?? '',
      lastName:            input.fullName.split(' ').slice(1).join(' ') ?? '',
      enabled:             true,
      federatedIdentities: [
        { identityProvider: 'aad', userId: input.aadOid ?? '', userName: input.email },
      ],
    };
  } else {
    userPayload = {
      username:        input.email,
      email:           input.email,
      firstName:       input.fullName.split(' ')[0] ?? '',
      lastName:        input.fullName.split(' ').slice(1).join(' ') ?? '',
      enabled:         true,
      credentials:     [],
      requiredActions: ['CONFIGURE_TOTP', 'UPDATE_PASSWORD'],
    };
  }

  const resp = await fetch(createUrl, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(userPayload),
  });

  if (!resp.ok && resp.status !== 409) {
    throw new Error(`Keycloak createUser failed: ${resp.status} ${await resp.text()}`);
  }

  // Extract user ID from the Location header: .../users/{uuid}
  const location = resp.headers.get('Location') ?? '';
  const keycloakId = location.split('/').at(-1) ?? '';

  if (!keycloakId) {
    throw new Error('Keycloak createUser: could not extract user ID from Location header');
  }

  return CreateKeycloakUserOutputSchema.parse({ keycloakId });
}
