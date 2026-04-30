import { z } from 'zod';
import { getKcAdmin, kcAdminRequest } from '../../../services/keycloak-admin.js';

export interface DetachAadFederationInput {
  tenantId:   string;
  keycloakId: string;
}

const OutputSchema = z.object({ ok: z.literal(true) });

export async function detachAadFederationActivity(
  input: DetachAadFederationInput,
): Promise<{ ok: true }> {
  const admin = await getKcAdmin(input.tenantId);
  const resp = await kcAdminRequest(
    admin, 'DELETE',
    `/users/${input.keycloakId}/federated-identity/aad`,
  );
  // 404 = already detached; treat as success (idempotent).
  if (!resp.ok && resp.status !== 404) {
    throw new Error(`detachAadFederation: HTTP ${resp.status} ${await resp.text()}`);
  }
  return OutputSchema.parse({ ok: true });
}
