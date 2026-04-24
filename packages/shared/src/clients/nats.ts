import { connect, NatsConnection, StringCodec } from 'nats';

let _connection: NatsConnection | null = null;

export async function getNatsConnection(): Promise<NatsConnection> {
  if (_connection) return _connection;
  const url = process.env['NATS_URL'] ?? 'nats://nats.cip-infra.svc.cluster.local:4222';
  _connection = await connect({ servers: url });
  return _connection;
}

export const sc = StringCodec();
