import type { TurnContext } from '@microsoft/agents-hosting';
import type { AuthContext } from '@cip/shared';
import type { TenantContext } from './tenant-resolver.js';
import { getMcpClient } from '../mcp/client.js';

export interface BotAuthContext extends AuthContext {
  employeeId: string;
  permissions: Record<string, boolean>;
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
  tenantCtx: TenantContext,
  keycloakJwt: string,
): Promise<BotAuthContext> {
  const aadOid: string =
    ((context.activity.from as unknown) as Record<string, unknown>)['aadObjectId'] as string ?? '';

  const client = await getMcpClient(keycloakJwt);

  await client.callTool({ name: 'sync_employee', arguments: {} });

  const permsResult = await client.callTool({ name: 'get_employee_permissions', arguments: {} });
  const permsResponse = JSON.parse(extractText(permsResult.content)) as {
    data?: { permissions?: string[]; roles?: string[] };
  };
  const permsArray: string[] = permsResponse.data?.permissions ?? [];
  const permissions: Record<string, boolean> = Object.fromEntries(
    permsArray.map(p => [p, true]),
  );
  const roles: string[] = permsResponse.data?.roles ?? [];

  return {
    tenantId:    tenantCtx.cipTenantId,
    userId:      context.activity.from?.id ?? '',
    employeeId:  aadOid,
    permissions,
    roles,
    bearerToken: keycloakJwt,
    tenantConfig: {
      tenantId:          tenantCtx.cipTenantId,
      name:              tenantCtx.cipTenantId,
      litellmVirtualKey: process.env['LITELLM_VIRTUAL_KEY'] ?? '',
      keycloakRealm:     tenantCtx.realm,
      natsPrefix:        `cip.${tenantCtx.cipTenantId}`,
      langfuseTags:      {},
    },
  };
}
