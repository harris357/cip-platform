import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

/**
 * HR Domain MCP Server.
 * All tools extract tenantId from the JWT — never from tool arguments.
 * This file registers tools; tool implementations live in ./tools/
 */
const server = new McpServer({ name: 'cip-hr-domain', version: '0.1.0' });

server.tool(
  'get_worker_certifications',
  'Returns all certifications for a worker. tenantId is extracted from the auth context.',
  {
    workerId: z.string().uuid().describe('The worker UUID'),
  },
  async ({ workerId }, extra) => {
    // TODO: extract tenantId from extra.authInfo (JWT)
    void workerId;
    void extra;
    throw new Error('get_worker_certifications: not yet implemented');
  },
);

server.tool(
  'get_compliance_status',
  'Returns current compliance status for a worker on a specific site.',
  {
    workerId: z.string().uuid(),
    siteId: z.string().uuid(),
  },
  async ({ workerId, siteId }, extra) => {
    void workerId;
    void siteId;
    void extra;
    throw new Error('get_compliance_status: not yet implemented');
  },
);

server.tool(
  'trigger_cert_upload',
  'Triggers the certification upload workflow for a worker.',
  {
    workerId: z.string().uuid(),
    objectStoreKey: z.string(),
  },
  async ({ workerId, objectStoreKey }, extra) => {
    void workerId;
    void objectStoreKey;
    void extra;
    // TODO: start CertificationProcessingWorkflow via Temporal client
    // Workflow ID: cert-processing-{tenantId}-{certificationId}
    throw new Error('trigger_cert_upload: not yet implemented');
  },
);

export async function startMcpServer(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.log('HR Domain MCP Server running');
}
