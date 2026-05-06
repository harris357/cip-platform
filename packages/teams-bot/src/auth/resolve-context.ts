import type { TurnContext } from '@microsoft/agents-hosting';
import type { AuthContext } from '@cip/shared';
import type { TenantContext } from './tenant-resolver.js';
import { getMcpClientFor } from '../mcp/multi-server-client.js';

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

  // Slice 66: two-call provisioning pattern.
  //   1. platform-core sync_user — always (creates/updates User + identity links)
  //   2. hr-service ensure_employee — may auto-create Employee per tenant flag
  //   3. hr-service get_employee_permissions — for the permission map
  // Steps 2 + 3 stay together for now since most bot turns invoke an HR tool.
  // Future optimisation: move ensure_employee behind a per-turn check that
  // skips it when no HR tool is in the candidate set.
  const tConnect0 = Date.now();
  const platformClient = await getMcpClientFor('platform-core', keycloakJwt);
  const hrClient       = await getMcpClientFor('hr-service',    keycloakJwt);
  const tConnect = Date.now();

  await platformClient.callTool({ name: 'sync_user', arguments: {} });
  const tSyncUser = Date.now();

  const ensureResult = await hrClient.callTool({ name: 'ensure_employee', arguments: {} });
  const tEnsure = Date.now();

  // ensure_employee may return user_not_found / not_provisioned_in_hr; in
  // those cases permissions are still meaningful (user exists; just no HR
  // employment relationship). Surface but don't fail the turn.
  const ensureResponse = JSON.parse(extractText(ensureResult.content)) as {
    data?: { employeeId?: string };
    error?: string;
  };
  if (ensureResponse.error) {
    console.log(`[auth-resolve] ensure_employee returned ${ensureResponse.error} (continuing)`);
  }

  const permsResult = await hrClient.callTool({ name: 'get_employee_permissions', arguments: {} });
  const tPerms = Date.now();
  console.log(
    `[auth-resolve] tenantId=${tenantCtx.cipTenantId} connect=${tConnect - tConnect0}ms ` +
    `sync_user=${tSyncUser - tConnect}ms ensure=${tEnsure - tSyncUser}ms ` +
    `perms=${tPerms - tEnsure}ms total=${tPerms - tConnect0}ms`,
  );

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
