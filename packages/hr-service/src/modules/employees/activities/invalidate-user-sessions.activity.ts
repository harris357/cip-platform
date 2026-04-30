import { z } from 'zod';
import { getKcAdmin, kcAdminRequest } from '../../../services/keycloak-admin.js';

export interface InvalidateUserSessionsInput {
  tenantId:   string;
  keycloakId: string;
}

const OutputSchema = z.object({ ok: z.literal(true) });

export async function invalidateUserSessionsActivity(
  input: InvalidateUserSessionsInput,
): Promise<{ ok: true }> {
  const admin = await getKcAdmin(input.tenantId);
  const resp = await kcAdminRequest(admin, 'POST', `/users/${input.keycloakId}/logout`);
  if (!resp.ok && resp.status !== 204) {
    throw new Error(`invalidateUserSessions: HTTP ${resp.status} ${await resp.text()}`);
  }
  return OutputSchema.parse({ ok: true });
}
