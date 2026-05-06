// Slice 58B-2b → 69 — thin compatibility wrapper.
//
// The bot now talks to N module-scoped MCP endpoints. The remaining caller
// of this helper is channel-registry.ts (uses get_tenant_channel_config,
// which lives in hr.settings post-slice-69). Future cleanup: migrate
// channel-registry to getMcpClientFor('hr.settings', token) directly and
// delete this file.

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getMcpClientFor } from './multi-server-client.js';

/** @deprecated use getMcpClientFor('hr.settings', token) directly. */
export async function getMcpClient(bearerToken: string): Promise<Client> {
  return getMcpClientFor('hr.settings', bearerToken);
}
