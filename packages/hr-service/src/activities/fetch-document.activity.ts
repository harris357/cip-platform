export interface FetchDocumentInput {
  tenantId: string;
  objectStoreKey: string;
}

export interface FetchDocumentOutput {
  base64: string;
  metadata: Record<string, string>;
}

export async function fetchDocument(input: FetchDocumentInput): Promise<FetchDocumentOutput> {
  void input;
  // TODO: fetch from OVH Object Store using @aws-sdk/client-s3 with AWS_ENDPOINT_URL
  throw new Error('fetchDocument: not implemented');
}
