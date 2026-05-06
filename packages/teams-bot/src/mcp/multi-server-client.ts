// Slice 58B-2b → 71b — multi-server MCP registry.
//
// Slice 71b: the bot stops hardcoding module names. Each upstream service
// exposes a discovery endpoint at GET /mcp/_modules that returns the
// endpoints it serves. At first use, the bot fetches this list from each
// configured BASE URL and assembles the full server registry.
//
// The bot's configuration is just: a list of service base URLs. Module
// identity, endpoint paths, and naming all come from the services
// themselves — same source-of-truth pattern as MCP tool annotations.
//
// ServerName is intentionally `string` — runtime-discovered, not a TS
// union of hardcoded literals.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export type ServerName = string;

export interface ServerEntry {
  name: ServerName;
  url:  string;
}

interface ModulesManifest {
  endpoints: Array<{ name: string; path: string }>;
}

/**
 * Service base URLs the bot fetches /mcp/_modules from at startup.
 * Each service decides its own module list and naming. The bot just trusts
 * the manifest.
 */
function resolveBaseUrls(): string[] {
  const hrBase       = process.env['HR_SERVICE_BASE_URL']       ?? 'http://hr-service.cip-app.svc.cluster.local:4001';
  const docBase      = process.env['DOCUMENT_SERVICE_BASE_URL'] ?? 'http://document-service.cip-app.svc.cluster.local:3000';
  const platformBase = process.env['PLATFORM_CORE_BASE_URL']    ?? 'http://platform-core.cip-app.svc.cluster.local:3001';
  return [hrBase, docBase, platformBase];
}

let serversPromise: Promise<ServerEntry[]> | null = null;

async function fetchManifest(baseUrl: string): Promise<ServerEntry[]> {
  const url = `${baseUrl.replace(/\/$/, '')}/mcp/_modules`;
  const resp = await fetch(url, { method: 'GET' });
  if (!resp.ok) {
    console.warn(`[mcp-discovery] ${url} HTTP ${resp.status} — skipping`);
    return [];
  }
  const manifest = (await resp.json()) as ModulesManifest;
  return manifest.endpoints.map(ep => ({
    name: ep.name,
    url:  `${baseUrl.replace(/\/$/, '')}${ep.path}`,
  }));
}

async function loadServers(): Promise<ServerEntry[]> {
  const bases = resolveBaseUrls();
  const lists = await Promise.all(bases.map(fetchManifest));
  const flat = lists.flat();
  if (flat.length === 0) {
    throw new Error('mcp-discovery: no MCP endpoints discovered from any base URL');
  }
  console.log(`[mcp-discovery] discovered ${flat.length} endpoint(s):`,
    flat.map(s => `${s.name}=${s.url}`).join(', '));
  return flat;
}

export async function getServers(): Promise<ReadonlyArray<ServerEntry>> {
  if (!serversPromise) serversPromise = loadServers();
  return serversPromise;
}

// Per-(server, bearerToken) Client cache. Bearer tokens are short-lived
// (Keycloak access tokens), so this map naturally drains as tokens rotate.
const clientCache = new Map<string, Client>();

function cacheKey(server: ServerName, bearerToken: string): string {
  return `${server}:${bearerToken}`;
}

export async function getMcpClientFor(
  server:      ServerName,
  bearerToken: string,
): Promise<Client> {
  const key = cacheKey(server, bearerToken);
  const cached = clientCache.get(key);
  if (cached) return cached;

  const servers = await getServers();
  const entry = servers.find(s => s.name === server);
  if (!entry) throw new Error(`getMcpClientFor: unknown server "${server}" (discovered: ${servers.map(s => s.name).join(', ')})`);

  const transport = new StreamableHTTPClientTransport(new URL(entry.url), {
    requestInit: { headers: { Authorization: `Bearer ${bearerToken}` } },
  });
  const client = new Client({ name: 'teams-bot', version: '1.0.0' });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await client.connect(transport as any);
  clientCache.set(key, client);
  return client;
}

// ─────────────────────────────────────────────────────────────────────
// Tool → server routing table.
// Populated by tool-discovery when it merges per-server catalogs.
// `executeTool` queries this map to know which Client to send a call to.
// Throws on collision: hard rule #1.
// ─────────────────────────────────────────────────────────────────────

const toolRouting = new Map<string, ServerName>();

export interface ToolCollisionError {
  toolName: string;
  servers:  ServerName[];
}

export function setToolRouting(toolName: string, server: ServerName): void {
  const existing = toolRouting.get(toolName);
  if (existing && existing !== server) {
    throw new Error(
      `MCP tool name collision: "${toolName}" is exposed by both ` +
      `"${existing}" and "${server}". Tool names must be globally unique ` +
      `across all MCP servers the bot connects to.`,
    );
  }
  toolRouting.set(toolName, server);
}

export function getServerForTool(toolName: string): ServerName | undefined {
  return toolRouting.get(toolName);
}

/** Test-only — clear caches between cases. */
export function _resetMultiServerCaches(): void {
  clientCache.clear();
  toolRouting.clear();
  serversPromise = null;
}
