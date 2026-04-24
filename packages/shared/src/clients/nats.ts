import { connect, NatsConnection, JetStreamManager } from 'nats';

export interface NatsClientOptions {
  url?: string;
}

export async function createNatsClient(opts?: NatsClientOptions): Promise<NatsConnection> {
  const url = opts?.url ?? process.env['NATS_URL'] ?? 'nats://localhost:4222';
  return connect({ servers: url });
}

export async function createJetStreamManager(nc: NatsConnection): Promise<JetStreamManager> {
  return nc.jetstreamManager();
}
