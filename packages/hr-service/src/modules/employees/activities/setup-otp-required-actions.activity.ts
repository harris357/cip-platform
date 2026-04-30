import { z } from 'zod';
import { getKcAdmin, kcAdminRequest } from '../../../services/keycloak-admin.js';

export interface SetupOtpRequiredActionsInput {
  tenantId:   string;
  keycloakId: string;
  phone:      string;
}

const OutputSchema = z.object({ ok: z.literal(true) });

export async function setupOtpRequiredActionsActivity(
  input: SetupOtpRequiredActionsInput,
): Promise<{ ok: true }> {
  const admin = await getKcAdmin(input.tenantId);

  const userResp = await kcAdminRequest(admin, 'GET', `/users/${input.keycloakId}`);
  if (!userResp.ok) {
    throw new Error(`setupOtpRequiredActions: GET user HTTP ${userResp.status}`);
  }
  const user = (await userResp.json()) as Record<string, unknown>;
  user['requiredActions'] = ['CONFIGURE_TOTP', 'UPDATE_PASSWORD'];

  // attributes is a Record<string, string[]> in KC; preserve any existing.
  const existingAttrs = (user['attributes'] ?? {}) as Record<string, string[]>;
  user['attributes'] = { ...existingAttrs, phoneNumber: [input.phone] };

  const putResp = await kcAdminRequest(admin, 'PUT', `/users/${input.keycloakId}`, user);
  if (!putResp.ok) {
    throw new Error(`setupOtpRequiredActions: PUT user HTTP ${putResp.status} ${await putResp.text()}`);
  }
  return OutputSchema.parse({ ok: true });
}
