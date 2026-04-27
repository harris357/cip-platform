import type { TurnContext } from 'botbuilder';
import type { AuthContext } from '@cip/shared';
import { getMcpClient } from '../mcp/client.js';

export interface BotAuthContext extends AuthContext {
  employeeId: string;
  capabilities: Record<string, boolean>;
  bearerToken: string;
}

async function exchangeAadForKeycloak(aadToken: string, tenantId: string): Promise<string> {
  const keycloakBase = process.env['KEYCLOAK_URL'] ?? 'http://keycloak:8080';
  const clientId = process.env['KEYCLOAK_CLIENT_ID'] ?? 'teams-bot';
  const clientSecret = process.env['KEYCLOAK_CLIENT_SECRET'] ?? '';
  const url = `${keycloakBase}/realms/${tenantId}/protocol/openid-connect/token`;

  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
    subject_token: aadToken,
    subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
    client_id: clientId,
    client_secret: clientSecret,
    requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
  });

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!response.ok) {
    throw new Error(`Keycloak token exchange failed: ${response.status} ${await response.text()}`);
  }
  const data = await response.json() as { access_token?: string };
  if (!data.access_token) throw new Error('Keycloak token exchange returned no access_token');
  return data.access_token;
}

function resolveAadToken(context: TurnContext): string {
  // Teams SSO delivers the AAD token in signin/tokenExchange activity value
  const token = (context.activity.value as { token?: string } | undefined)?.token;
  if (!token) {
    throw new Error(
      'No AAD token found in turn context — ensure Teams SSO is configured and the user has signed in',
    );
  }
  return token;
}

function extractText(content: unknown): string {
  if (!Array.isArray(content)) return '{}';
  for (const item of content as Array<{ type?: unknown; text?: unknown }>) {
    if (item.type === 'text' && typeof item.text === 'string') return item.text;
  }
  return '{}';
}

export async function resolveAuthContext(context: TurnContext): Promise<BotAuthContext> {
  const tenantId: string =
    (context.activity.channelData as { tenant?: { id?: string } } | undefined)?.tenant?.id ?? '';

  const aadOid: string =
    ((context.activity.from as unknown) as Record<string, unknown>)['aadObjectId'] as string ?? '';

  const aadToken = resolveAadToken(context);
  const keycloakJwt = await exchangeAadForKeycloak(aadToken, tenantId);
  const client = await getMcpClient(keycloakJwt);

  const capsResult = await client.callTool({ name: 'get_employee_capabilities', arguments: {} });
  const capsResponse = JSON.parse(extractText(capsResult.content)) as {
    data?: { capabilities?: Record<string, boolean>; roles?: string[] };
  };
  const capabilities: Record<string, boolean> = capsResponse.data?.capabilities ?? {};
  const roles: string[] = capsResponse.data?.roles ?? [];

  return {
    tenantId,
    userId: context.activity.from.id,
    employeeId: aadOid,
    capabilities,
    roles,
    bearerToken: keycloakJwt,
    tenantConfig: {
      tenantId,
      name: tenantId,
      litellmVirtualKey: '',
      keycloakRealm: tenantId,
      natsPrefix: `cip.${tenantId}`,
      langfuseTags: {},
    },
  };
}
