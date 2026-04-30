import { z } from 'zod';
import { getKcAdmin, kcAdminRequest } from '../../../services/keycloak-admin.js';

export interface AttachAadFederationInput {
  tenantId:    string;
  keycloakId:  string;
  aadOid:      string;
  email:       string;
}

const OutputSchema = z.object({ ok: z.literal(true) });

export async function attachAadFederationActivity(
  input: AttachAadFederationInput,
): Promise<{ ok: true }> {
  const admin = await getKcAdmin(input.tenantId);
  const resp = await kcAdminRequest(
    admin, 'POST',
    `/users/${input.keycloakId}/federated-identity/aad`,
    { identityProvider: 'aad', userId: input.aadOid, userName: input.email },
  );
  if (!resp.ok && resp.status !== 409) {
    throw new Error(`attachAadFederation: HTTP ${resp.status} ${await resp.text()}`);
  }
  return OutputSchema.parse({ ok: true });
}
