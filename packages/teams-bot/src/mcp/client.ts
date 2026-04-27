import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export async function getMcpClient(bearerToken: string): Promise<Client> {
  const serverUrl = process.env['MCP_SERVER_URL'];
  if (!serverUrl) throw new Error('MCP_SERVER_URL is not set');

  const transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
    requestInit: { headers: { Authorization: `Bearer ${bearerToken}` } },
  });
  const client = new Client({ name: 'teams-bot', version: '1.0.0' });
  // Transport.sessionId is required (string) but SDK types it as string | undefined under
  // exactOptionalPropertyTypes — safe cast, the value is always present at runtime.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await client.connect(transport as any);
  return client;
}
