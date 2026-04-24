export interface PreClassifyCertInput {
  tenantId: string;
  documentMetadata: Record<string, string>;
}

export interface PreClassifyCertOutput {
  certType: string;
}

export async function preClassifyCert(input: PreClassifyCertInput): Promise<PreClassifyCertOutput> {
  void input;
  // TODO: Tier 1 deterministic classification — no AI, rules-based on file metadata
  throw new Error('preClassifyCert: not implemented');
}
