import type { ConversationReference, TurnContext } from 'botbuilder';
import { TurnContext as TC } from 'botbuilder';
import { getMcpClient } from '../mcp/client.js';

interface ChannelEntry {
  ref: Partial<ConversationReference>;
  expiresAt: number; // Date.now() + 24h
}

interface TenantChannelConfig {
  channels: Array<{ channelId: string; channelType: string }>;
}

const registry = new Map<string, ChannelEntry>();
const configCache = new Map<string, { config: TenantChannelConfig; expiresAt: number }>();
const CONFIG_TTL = 5 * 60 * 1000;

export function registerChannel(
  tenantId: string,
  channelType: string,
  ref: Partial<ConversationReference>,
): void {
  registry.set(`${tenantId}:${channelType}`, { ref, expiresAt: Date.now() + 86_400_000 });
}

export function getChannelRef(tenantId: string, channelType: string): Partial<ConversationReference> | null {
  const entry = registry.get(`${tenantId}:${channelType}`);
  if (!entry || Date.now() > entry.expiresAt) return null;
  return entry.ref;
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
  const ref = TC.getConversationReference(context.activity);

  for (const entry of config.channels) {
    if (entry.channelId === incomingChannelId) {
      registerChannel(tenantId, entry.channelType, ref);
    }
  }
}
