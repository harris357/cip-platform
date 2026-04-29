import type { TurnContext } from '@microsoft/agents-hosting';
import type { ConversationReference } from '@microsoft/agents-activity';
import { getNatsConnection } from '@cip/shared/src/clients/nats.js';
import { getMcpClient } from '../mcp/client.js';

const BUCKET = process.env['CHANNEL_REGISTRY_BUCKET'] ?? 'teams-channel-registry';
const TTL_MS = 24 * 60 * 60 * 1000; // 24 h — matches previous in-memory TTL

interface TenantChannelConfig {
  channels: Array<{ channelId: string; channelType: string }>;
}

const configCache = new Map<string, { config: TenantChannelConfig; expiresAt: number }>();
const CONFIG_TTL = 5 * 60 * 1000;

// KV type inferred from nats — avoid direct nats import in this package
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _kv: any;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getKv(): Promise<any> {
  if (!_kv) {
    const nc = await getNatsConnection();
    const js = nc.jetstream();
    // Lazy-create the bucket if it doesn't exist; idempotent across pods.
    _kv = await js.views.kv(BUCKET, { history: 1, ttl: TTL_MS });
  }
  return _kv;
}

// Key: tenantId.channelType  — tenant isolation is baked into every key
function buildKey(tenantId: string, channelType: string): string {
  return `${tenantId}.${channelType}`;
}

export async function registerChannel(
  tenantId: string,
  channelType: string,
  ref: Partial<ConversationReference>,
): Promise<void> {
  const kv = await getKv();
  await kv.put(buildKey(tenantId, channelType), JSON.stringify(ref));
}

export async function getChannelRef(
  tenantId: string,
  channelType: string,
): Promise<Partial<ConversationReference> | null> {
  const kv = await getKv();
  const entry = await kv.get(buildKey(tenantId, channelType));
  if (!entry) return null;
  return JSON.parse(entry.string()) as Partial<ConversationReference>;
}

function extractText(content: unknown): string {
  if (!Array.isArray(content)) return '{"channels":[]}';
  for (const item of content as Array<{ type?: unknown; text?: unknown }>) {
    if (item.type === 'text' && typeof item.text === 'string') return item.text;
  }
  return '{"channels":[]}';
}

export async function updateChannelRegistry(
  context: TurnContext,
  tenantId: string,
  bearerToken: string,
): Promise<void> {
  let config: TenantChannelConfig;
  const cached = configCache.get(tenantId);
  if (cached && Date.now() < cached.expiresAt) {
    config = cached.config;
  } else {
    const client = await getMcpClient(bearerToken);
    // get_tenant_channel_config — no args: tenantId comes from bearer token (non-negotiable #6)
    const result = await client.callTool({ name: 'get_tenant_channel_config', arguments: {} });
    const raw = JSON.parse(extractText(result.content)) as {
      data?: { channelConfig?: TenantChannelConfig };
    };
    config = raw.data?.channelConfig ?? { channels: [] };
    configCache.set(tenantId, { config, expiresAt: Date.now() + CONFIG_TTL });
  }

  const incomingChannelId: string =
    (context.activity.channelData as { channel?: { id?: string } } | undefined)?.channel?.id ??
    context.activity.channelId ??
    '';
  const ref = context.activity.getConversationReference();

  for (const entry of config.channels) {
    if (entry.channelId === incomingChannelId) {
      await registerChannel(tenantId, entry.channelType, ref);
    }
  }
}
