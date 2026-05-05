// Slice 58B-2b — thin compatibility wrapper.
//
// The bot now talks to two MCP servers (see multi-server-client.ts).
// Pre-2b code (auth/resolve-context, teams-protocol/channel-registry)
// hard-coded an hr-service-only `getMcpClient(bearerToken)` import.
// Rather than touch every call site in this slice, we delegate to the
// new multi-server registry pinned to hr-service.
//
// Future cleanup: migrate the two remaining call sites
// (resolveAuthContext + updateChannelRegistry) to call
// `getMcpClientFor('hr-service', token)` directly and delete this file.

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getMcpClientFor } from './multi-server-client.js';

/** @deprecated use getMcpClientFor('hr-service', token) directly. */
export async function getMcpClient(bearerToken: string): Promise<Client> {
  return getMcpClientFor('hr-service', bearerToken);
}
