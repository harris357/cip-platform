import { connect, StringCodec, type NatsConnection, type JetStreamManager } from 'nats';

export interface NatsClientOptions {
  url?: string;
}

export const sc = StringCodec();

let _nc: NatsConnection | undefined;

export async function getNatsConnection(): Promise<NatsConnection> {
  if (!_nc) {
    const url = process.env['NATS_URL'] ?? 'nats://localhost:4222';
    _nc = await connect({ servers: url });
  }
  return _nc;
}

export async function createNatsClient(opts?: NatsClientOptions): Promise<NatsConnection> {
  const url = opts?.url ?? process.env['NATS_URL'] ?? 'nats://localhost:4222';
  return connect({ servers: url });
}

export async function createJetStreamManager(nc: NatsConnection): Promise<JetStreamManager> {
  return nc.jetstreamManager();
}
