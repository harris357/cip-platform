export async function issueLiteLLMVirtualKey(input: {
  tenantId: string;
  tier: 'standard' | 'premium' | 'enterprise';
  budgetLimitUsd: number;
}): Promise<void> {
  void input;
  // TODO: call LiteLLM admin API to create virtual key with budget limit
  throw new Error('issueLiteLLMVirtualKey: not implemented');
}
