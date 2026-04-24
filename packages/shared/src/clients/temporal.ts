import { Connection, Client } from '@temporalio/client';
import { NativeConnection } from '@temporalio/worker';

function getTemporalEnv() {
  const address   = process.env['TEMPORAL_ADDRESS'];
  const namespace = process.env['TEMPORAL_NAMESPACE'];
  const apiKey    = process.env['TEMPORAL_API_KEY'];
  if (!address || !namespace || !apiKey) {
    throw new Error('Missing TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE, or TEMPORAL_API_KEY');
  }
  return { address, namespace, apiKey };
}

export async function createTemporalWorkerConnection(): Promise<NativeConnection> {
  const { address, apiKey } = getTemporalEnv();
  return NativeConnection.connect({
    address,
    tls: true,
    metadata: { authorization: `Bearer ${apiKey}` },
  });
}

export async function createTemporalClient(tenantNamespace?: string): Promise<Client> {
  const { address, namespace, apiKey } = getTemporalEnv();
  const connection = await Connection.connect({
    address,
    tls: true,
    metadata: { authorization: `Bearer ${apiKey}` },
  });
  return new Client({ connection, namespace: tenantNamespace ?? namespace });
}
