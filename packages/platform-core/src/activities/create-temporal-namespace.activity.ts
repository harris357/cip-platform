export async function createTemporalNamespace(input: { tenantId: string }): Promise<void> {
  void input;
  // TODO: create Temporal namespace via Temporal Cloud API
  // Namespace convention: {tenantId}.cip
  throw new Error('createTemporalNamespace: not implemented');
}
