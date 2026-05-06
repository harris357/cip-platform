// Slice 58B-2b — multi-server MCP registry.
//
// The bot now talks to TWO upstream MCP servers:
//   - hr-service (legacy/baseline; HR + cert + tunables)
//   - document-service (new; document_process, documents_status)
//
// This module owns the per-server URL list, the per-(server, bearerToken)
// `Client` instance cache, and the toolName → server lookup table that
// `executeTool` uses to route calls.
//
// Design notes:
//   - URLs come from env (HR_SERVICE_MCP_URL, DOCUMENT_SERVICE_MCP_URL)
//     with cluster-internal defaults so a missing env var still produces
//     a sane image. Existing pods read MCP_SERVER_URL — we honour that as
//     a fallback for hr-service for backward compat.
//   - One `Client` per (server, bearerToken) — same shape as the old
//     `getMcpClient(bearerToken)` cache, just now keyed by server too.
//     Clients are cached because `client.connect(transport)` is non-trivial
//     work to repeat each call.
//   - Collision detection lives in `setToolRouting` (called by
//     `tool-discovery` at catalog-merge time): same tool name from two
//     servers → throw, fail loud at startup. Hard rule #1.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// Slice 69: module-scoped server names. Each module is now its own MCP
// endpoint (foundation for Arc 2 multi-agent). Format: <service>.<module>.
// platform-core stays unscoped — it's a single endpoint.
export type ServerName =
  | 'platform-core'
  | 'hr.cert' | 'hr.employee' | 'hr.compliance' | 'hr.people' | 'hr.settings' | 'hr.admin'
  | 'documents.ingest' | 'documents.routing';

export interface ServerEntry {
  name: ServerName;
  url:  string;
}

function resolveServers(): ServerEntry[] {
  // Slice 69: each service has a base URL; per-module endpoints are sub-paths.
  // Per-module env overrides (HR_CERT_MCP_URL, etc.) take precedence; otherwise
  // we derive `${BASE}/mcp/<module>` from the base URL.
  const hrBase   = process.env['HR_SERVICE_BASE_URL']       ?? 'http://hr-service.cip-app.svc.cluster.local:4001';
  const docBase  = process.env['DOCUMENT_SERVICE_BASE_URL'] ?? 'http://document-service.cip-app.svc.cluster.local:3000';
  const platform = process.env['PLATFORM_CORE_MCP_URL']     ?? 'http://platform-core.cip-app.svc.cluster.local:3001/mcp/platform';

  const hrUrl    = (m: string): string => process.env[`HR_${m.toUpperCase()}_MCP_URL`]   ?? `${hrBase}/mcp/${m}`;
  const docUrl   = (m: string): string => process.env[`DOCUMENTS_${m.toUpperCase()}_MCP_URL`] ?? `${docBase}/mcp/${m}`;

  return [
    { name: 'platform-core',     url: platform        },
    { name: 'hr.cert',           url: hrUrl('cert')   },
    { name: 'hr.employee',       url: hrUrl('employee') },
    { name: 'hr.compliance',     url: hrUrl('compliance') },
    { name: 'hr.people',         url: hrUrl('people') },
    { name: 'hr.settings',       url: hrUrl('settings') },
    { name: 'hr.admin',          url: hrUrl('admin')  },
    { name: 'documents.ingest',  url: docUrl('ingest') },
    { name: 'documents.routing', url: docUrl('routing') },
  ];
}

const SERVERS: ServerEntry[] = resolveServers();

export function getServers(): ReadonlyArray<ServerEntry> {
  return SERVERS;
}

// Per-(server, bearerToken) Client cache. Bearer tokens are short-lived
// (Keycloak access tokens), so this map naturally drains as tokens rotate.
// Same shape as the previous single-server cache that lived in client.ts.
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

  const entry = SERVERS.find(s => s.name === server);
  if (!entry) throw new Error(`getMcpClientFor: unknown server "${server}"`);

  const transport = new StreamableHTTPClientTransport(new URL(entry.url), {
    requestInit: { headers: { Authorization: `Bearer ${bearerToken}` } },
  });
  const client = new Client({ name: 'teams-bot', version: '1.0.0' });
  // SDK transport types omit sessionId at the boundary; safe cast,
  // matches the pattern in the prior single-server client.ts.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await client.connect(transport as any);
  clientCache.set(key, client);
  return client;
}

// ─────────────────────────────────────────────────────────────────────
// Tool → server routing table.
//
// Populated by tool-discovery when it merges per-server catalogs.
// `executeTool` queries this map to know which Client to send a call to.
//
// Throws on collision: hard rule #1. The bot must never silently prefer
// one server's `foo` over another's `foo`.
// ─────────────────────────────────────────────────────────────────────

const toolRouting = new Map<string, ServerName>();

export interface ToolCollisionError {
  toolName: string;
  servers:  ServerName[];
}

/**
 * Register one tool's owning server. Throws if a different server has
 * already claimed the same name. Idempotent for repeat (toolName, server)
 * pairs (cache refreshes hit this path).
 */
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
}
