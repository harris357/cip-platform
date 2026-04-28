import { z } from 'zod';

const LiteLLMKeyResponseSchema = z.object({ key: z.string().min(1) });

export async function issueLiteLLMVirtualKey(input: {
  tenantId: string;
  tier: 'standard' | 'premium' | 'enterprise';
  budgetLimitUsd: number;
}): Promise<string> {
  const litellmBase = process.env['LITELLM_BASE_URL'] ?? 'http://litellm:4000';
  const masterKey   = process.env['LITELLM_MASTER_KEY'] ?? '';

  const resp = await fetch(`${litellmBase}/key/generate`, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${masterKey}`,
    },
    body: JSON.stringify({
      key_alias:       `tenant-${input.tenantId}`,
      team_id:         input.tenantId,
      max_budget:      input.budgetLimitUsd,
      budget_duration: '30d',
      metadata:        { tenantId: input.tenantId, tier: input.tier },
    }),
  });

  if (!resp.ok) {
    throw new Error(`issueLiteLLMVirtualKey: ${resp.status} ${await resp.text()}`);
  }

  const data = LiteLLMKeyResponseSchema.parse(await resp.json());
  return data.key;
}
