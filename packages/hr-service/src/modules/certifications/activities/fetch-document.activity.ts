export interface FetchDocumentInput {
  tenantId: string;
  objectStoreKey: string;
}

export interface FetchDocumentOutput {
  documentBase64: string;
}

export async function fetchDocumentActivity(
  input: FetchDocumentInput,
): Promise<FetchDocumentOutput> {
  void input;
  throw new Error('not implemented');
}
