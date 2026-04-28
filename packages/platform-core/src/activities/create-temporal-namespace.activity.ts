import { z } from 'zod';

const OutputSchema = z.object({ namespace: z.string() });

export async function createTemporalNamespace(input: { tenantId: string }): Promise<void> {
  // Namespace convention: ${tenantId}.cip — matches watcher.ts and handleCertExpired
  const namespace = `${input.tenantId}.cip`;

  // Temporal gRPC-gateway REST API (available in Temporal Cloud and self-hosted v1.19+)
  // Address: strip the port from TEMPORAL_ADDRESS and use gRPC-gateway on :443 (Cloud)
  // or same address (self-hosted). For self-hosted, use the same TEMPORAL_ADDRESS.
  const temporalAddr = process.env['TEMPORAL_ADDRESS'] ?? 'temporal:7233';
  const baseUrl = temporalAddr.includes('cloud.temporal.io')
    ? `https://${temporalAddr}/api/v0`
    : `http://${temporalAddr}/api/v1`;
  const apiKey = process.env['TEMPORAL_API_KEY'] ?? '';

  const resp = await fetch(`${baseUrl}/namespaces`, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      namespace,
      config: { workflowExecutionRetentionTtl: '2592000s' }, // 30 days
    }),
  });

  // 409 Conflict = namespace already exists — idempotent
  if (!resp.ok && resp.status !== 409) {
    const body = await resp.text();
    throw new Error(`createTemporalNamespace: ${resp.status} ${body}`);
  }

  OutputSchema.parse({ namespace });
}
