import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { getWorkerCertsHandler } from './tools/get-worker-certs.js';
import { getComplianceStatusHandler } from './tools/get-compliance-status.js';
import { triggerCertUploadHandler } from './tools/trigger-cert-upload.js';

/**
 * HR Domain MCP Server.
 * All tools extract tenantId from the JWT — never from tool arguments.
 */
const server = new McpServer({ name: 'cip-hr-domain', version: '0.1.0' });

function extractTenantIdFromJWT(token: string): string {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid JWT format');
  const payloadJson = Buffer.from(parts[1]!, 'base64url').toString('utf-8');
  const payload = JSON.parse(payloadJson) as Record<string, unknown>;
  const tenantId = payload['tenantId'];
  if (typeof tenantId !== 'string' || !tenantId) {
    throw new Error('JWT missing tenantId claim — check Keycloak Protocol Mapper');
  }
  return tenantId;
}

function getToken(extra: unknown): string {
  const auth = (extra as { authInfo?: { token?: string } } | undefined)?.authInfo;
  if (!auth?.token) throw new Error('Missing Bearer token in MCP auth context');
  return auth.token;
}

server.tool(
  'get_worker_certs',
  'Returns all certifications for a worker. tenantId is extracted from the auth context.',
  {
    workerId: z.string().uuid().describe('The worker UUID'),
  },
  async ({ workerId }, extra) => {
    const tenantId = extractTenantIdFromJWT(getToken(extra));
    const certs = await getWorkerCertsHandler(workerId, tenantId);
    return { content: [{ type: 'text' as const, text: JSON.stringify(certs) }] };
  },
);

server.tool(
  'get_compliance_status',
  'Returns current compliance status for a worker.',
  {
    workerId: z.string().uuid().describe('The worker UUID'),
  },
  async ({ workerId }, extra) => {
    const tenantId = extractTenantIdFromJWT(getToken(extra));
    const status = await getComplianceStatusHandler(workerId, tenantId);
    return { content: [{ type: 'text' as const, text: JSON.stringify(status) }] };
  },
);

server.tool(
  'trigger_cert_upload',
  'Triggers the certification upload workflow for a worker.',
  {
    workerId: z.string().uuid().describe('The worker UUID'),
    documentUrl: z.string().url().describe('URL of the certification document'),
    certType: z.string().describe('Type of certification (e.g. WHMIS, First Aid)'),
  },
  async ({ workerId, documentUrl, certType }, extra) => {
    const tenantId = extractTenantIdFromJWT(getToken(extra));
    const result = await triggerCertUploadHandler(workerId, documentUrl, certType, tenantId);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
  },
);

export async function startMcpServer(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.log('HR Domain MCP Server running');
}
