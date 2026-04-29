import type { TurnContext } from '@microsoft/agents-hosting';
import type { AuthContext } from '@cip/shared';
import { getMcpClient } from '../mcp/client.js';

export interface BotAuthContext extends AuthContext {
  employeeId: string;
  capabilities: Record<string, boolean>;
  bearerToken: string;
}

function extractText(content: unknown): string {
  if (!Array.isArray(content)) return '{}';
  for (const item of content as Array<{ type?: unknown; text?: unknown }>) {
    if (item.type === 'text' && typeof item.text === 'string') return item.text;
  }
  return '{}';
}

export async function resolveAuthContext(
  context: TurnContext,
  keycloakJwt: string,
): Promise<BotAuthContext> {
  const tenantId: string =
    (context.activity.channelData as { tenant?: { id?: string } } | undefined)?.tenant?.id ?? '';

  const aadOid: string =
    ((context.activity.from as unknown) as Record<string, unknown>)['aadObjectId'] as string ?? '';

  const client = await getMcpClient(keycloakJwt);

  await client.callTool({ name: 'sync_employee', arguments: {} });

  const capsResult = await client.callTool({ name: 'get_employee_capabilities', arguments: {} });
  const capsResponse = JSON.parse(extractText(capsResult.content)) as {
    data?: { capabilities?: Record<string, boolean>; roles?: string[] };
  };
  const capabilities: Record<string, boolean> = capsResponse.data?.capabilities ?? {};
  const roles: string[] = capsResponse.data?.roles ?? [];

  return {
    tenantId,
    userId: context.activity.from?.id ?? '',
    employeeId: aadOid,
    capabilities,
    roles,
    bearerToken: keycloakJwt,
    tenantConfig: {
      tenantId,
      name: tenantId,
      litellmVirtualKey: process.env['LITELLM_VIRTUAL_KEY'] ?? '',
      keycloakRealm: tenantId,
      natsPrefix: `cip.${tenantId}`,
      langfuseTags: {},
    },
  };
}
