import { z } from 'zod';
import { getPool } from '../db/index.js';

// Slice 70: replaces bash section 5b's UPDATE. The K8s secret creation
// itself stays in bash for now (slice 71 ports it). This activity assumes
// the operator (or slice 71's createK8sSecretActivity) has already
// created the K8s secret with the supplied name.

const InputSchema = z.object({
  tenantId:  z.string().uuid(),
  alias:     z.string().min(1).default('aad'),
  secretRef: z.string().min(1),
});
const OutputSchema = z.object({ updated: z.literal(true), rowsAffected: z.number() });
export type UpdateTenantIdpSecretRefInput  = z.infer<typeof InputSchema>;
export type UpdateTenantIdpSecretRefOutput = z.infer<typeof OutputSchema>;

export async function updateTenantIdpSecretRef(input: unknown): Promise<UpdateTenantIdpSecretRefOutput> {
  const parsed = InputSchema.parse(input);
  const pool = getPool();
  const client = await pool.connect();
  try {
    const r = await client.query(
      `UPDATE cip_platform.tenant_identity_providers
          SET secret_ref = $3, updated_at = NOW()
        WHERE tenant_id = $1 AND alias = $2`,
      [parsed.tenantId, parsed.alias, parsed.secretRef],
    );
    return OutputSchema.parse({ updated: true, rowsAffected: r.rowCount ?? 0 });
  } finally {
    client.release();
  }
}
