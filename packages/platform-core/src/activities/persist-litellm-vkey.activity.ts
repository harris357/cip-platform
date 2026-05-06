import { z } from 'zod';
import { getPool } from '../db/index.js';

// Slice 70: persist the issued LiteLLM virtual key into
// cip_platform.tenant_settings.litellm_virtual_key. Bash had this as a
// "manual fallback" instruction (line 555-556 of provision-tenant.sh);
// the workflow now does it deterministically.

const InputSchema = z.object({
  tenantId:           z.string().uuid(),
  litellmVirtualKey:  z.string().min(1),
});
const OutputSchema = z.object({ persisted: z.literal(true) });
export type PersistLiteLLMVirtualKeyInput  = z.infer<typeof InputSchema>;
export type PersistLiteLLMVirtualKeyOutput = z.infer<typeof OutputSchema>;

export async function persistLiteLLMVirtualKey(input: unknown): Promise<PersistLiteLLMVirtualKeyOutput> {
  const parsed = InputSchema.parse(input);
  const pool = getPool();
  const client = await pool.connect();
  try {
    // Idempotent UPSERT on (tenant_id) unique constraint. Re-running with
    // the same key is a no-op effective change; re-running with a new key
    // (e.g., key rotation) overwrites.
    await client.query(
      `INSERT INTO cip_platform.tenant_settings (tenant_id, litellm_virtual_key)
       VALUES ($1, $2)
       ON CONFLICT (tenant_id) DO UPDATE
         SET litellm_virtual_key = EXCLUDED.litellm_virtual_key,
             updated_at          = NOW()`,
      [parsed.tenantId, parsed.litellmVirtualKey],
    );
    return OutputSchema.parse({ persisted: true });
  } finally {
    client.release();
  }
}
