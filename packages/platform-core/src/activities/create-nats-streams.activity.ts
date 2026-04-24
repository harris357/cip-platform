export async function createNatsStreams(input: { tenantId: string }): Promise<void> {
  void input;
  // TODO: create NATS JetStream streams scoped to cip.{tenantId}.*
  throw new Error('createNatsStreams: not implemented');
}
