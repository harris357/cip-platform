export interface PreClassifyCertInput {
  tenantId: string;
  documentBase64: string;
}

export interface PreClassifyCertOutput {
  certTypeHint: string;
}

export async function preClassifyCertActivity(
  input: PreClassifyCertInput,
): Promise<PreClassifyCertOutput> {
  void input;
  throw new Error('not implemented');
}
