import { z } from 'zod';
import { getKcAdmin, kcAdminRequest } from '../../../services/keycloak-admin.js';

export interface ClearLocalCredentialsInput {
  tenantId:   string;
  keycloakId: string;
}

const OutputSchema = z.object({ ok: z.literal(true) });

export async function clearLocalCredentialsActivity(
  input: ClearLocalCredentialsInput,
): Promise<{ ok: true }> {
  const admin = await getKcAdmin(input.tenantId);

  // Remove all credentials (password, OTP secrets) from the KC user.
  const credsResp = await kcAdminRequest(admin, 'GET', `/users/${input.keycloakId}/credentials`);
  if (credsResp.ok) {
    const creds = (await credsResp.json()) as Array<{ id: string }>;
    for (const c of creds) {
      const del = await kcAdminRequest(admin, 'DELETE', `/users/${input.keycloakId}/credentials/${c.id}`);
      if (!del.ok && del.status !== 404) {
        throw new Error(`clearLocalCredentials: delete cred ${c.id} HTTP ${del.status}`);
      }
    }
  }

  // Clear requiredActions so the user isn't prompted to set up password/OTP.
  const userResp = await kcAdminRequest(admin, 'GET', `/users/${input.keycloakId}`);
  if (!userResp.ok) {
    throw new Error(`clearLocalCredentials: GET user HTTP ${userResp.status}`);
  }
  const user = (await userResp.json()) as Record<string, unknown>;
  user['requiredActions'] = [];
  const putResp = await kcAdminRequest(admin, 'PUT', `/users/${input.keycloakId}`, user);
  if (!putResp.ok) {
    throw new Error(`clearLocalCredentials: PUT user HTTP ${putResp.status} ${await putResp.text()}`);
  }
  return OutputSchema.parse({ ok: true });
}
