import { TurnContext } from '@microsoft/agents-hosting';
import { Activity } from '@microsoft/agents-activity';
import { TeamsActivityHandler } from '@microsoft/agents-hosting-extensions-teams';
import type { Tool as McpTool } from '@modelcontextprotocol/sdk/types.js';
import { resolveAuthContext } from './auth/resolve-context.js';
import { cacheToken, getCachedToken } from './auth/token-store.js';
import { updateChannelRegistry } from './teams-protocol/channel-registry.js';
import { detectFileAttachments, downloadToObjectStore } from './teams-protocol/file-handler.js';
import { renderResponse } from './teams-protocol/card-renderer.js';
import { discoverTools } from './mcp/tool-discovery.js';
import { routeIntent } from './intent/router.js';
import { executeTool } from './mcp/tool-executor.js';

export function buildWelcomeMessage(): string {
  return (
    'Hello! I can help you manage certifications and HR tasks. ' +
    'Send me a message or upload a certificate document to get started.'
  );
}

function buildNoToolMessage(tools: McpTool[]): string {
  return tools.length > 0
    ? "I'm not sure how to help with that. Try asking about your certifications or HR tasks."
    : "I don't have any tools available for your account. Please contact your administrator.";
}

async function exchangeAadForKeycloak(aadToken: string, tenantId: string): Promise<string> {
  const keycloakBase = process.env['KEYCLOAK_URL'] ?? 'http://keycloak:8080';
  const clientId = process.env['KEYCLOAK_CLIENT_ID'] ?? 'teams-bot';
  const clientSecret = process.env['KEYCLOAK_CLIENT_SECRET'] ?? '';
  // KEYCLOAK_REALM is the dev override (cip-dev); prod uses the AAD tenant GUID as realm name.
  const realm = process.env['KEYCLOAK_REALM'] ?? tenantId;
  const url = `${keycloakBase}/auth/realms/${realm}/protocol/openid-connect/token`;

  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
    subject_token: aadToken,
    subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
    subject_issuer: 'aad',
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
  const data = (await response.json()) as { access_token?: string };
  if (!data.access_token) throw new Error('Keycloak token exchange returned no access_token');
  return data.access_token;
}

export class CIPTeamsBot extends TeamsActivityHandler {
  constructor() {
    super();

    this.onMembersAdded(async (context, next) => {
      for (const member of context.activity.membersAdded ?? []) {
        if (member.id !== context.activity.recipient?.id) {
          await context.sendActivity(buildWelcomeMessage());
        }
      }
      await next();
    });

    this.onMessage(async (context: TurnContext, next) => {
      const userId = context.activity.from?.id ?? '';
      const keycloakJwt = getCachedToken(userId);

      if (!keycloakJwt) {
        // Interactive OAuth — no tokenExchangeResource means no silent SSO attempt.
        // Teams shows a "Sign in" button; user clicks once per session.
        // signin/verifyState or signin/tokenExchange arrives in onSigninInvokeActivity.
        const oauthCard = {
          contentType: 'application/vnd.microsoft.card.oauth',
          content: {
            connectionName: 'sso',
            title: 'Sign in to CIP',
            text: 'Please sign in to get started. This happens once per session.',
          },
        };
        console.log(`[auth] no cached token for user ${userId} — sending interactive OAuthCard connectionName=sso`);
        await context.sendActivity(Activity.fromObject({
          type: 'message',
          attachments: [oauthCard],
        }));
        await next();
        return;
      }

      const ctx = await resolveAuthContext(context, keycloakJwt);
      await updateChannelRegistry(context, ctx.tenantId, ctx.bearerToken);

      const fileAttachments = detectFileAttachments(context);

      if (fileAttachments.length > 0) {
        for (const file of fileAttachments) {
          const key = await downloadToObjectStore(file, ctx);
          const result = await executeTool('process_document', { objectStoreKey: key }, ctx);
          await renderResponse(context, result);
        }
      } else {
        const text = context.activity.text?.trim() ?? '';
        if (!text) {
          await next();
          return;
        }

        const tools = await discoverTools(ctx);
        const selected = await routeIntent(text, tools, ctx);

        if (selected) {
          const result = await executeTool(selected.name, selected.args, ctx);
          await renderResponse(context, result);
        } else {
          await context.sendActivity(buildNoToolMessage(tools));
        }
      }
      await next();
    });
  }

  // signin/failure is NOT routed through onSigninInvokeActivity — catch it here first.
  protected override async onInvokeActivity(context: TurnContext): Promise<{ status: number; body?: unknown }> {
    if (context.activity.name === 'signin/failure') {
      const err = context.activity.value as { code?: string; message?: string } | undefined;
      // Log everything — value, channelData, entities — to understand what Teams compared.
      console.error(`[sso] signin/failure value: ${JSON.stringify(err)}`);
      console.error(`[sso] signin/failure channelData: ${JSON.stringify(context.activity.channelData)}`);
      console.error(`[sso] signin/failure entities: ${JSON.stringify(context.activity.entities)}`);
      console.error(`[sso] signin/failure from: ${JSON.stringify(context.activity.from)}`);
      await context.sendActivity(
        `Sign-in failed (${err?.code ?? 'unknown'}): ${err?.message ?? JSON.stringify(err)}. ` +
        'Check Azure AD app registration or contact your administrator.',
      );
      return { status: 200 };
    }
    return super.onInvokeActivity(context);
  }

  // Teams SSO silent flow: signin/verifyState and signin/tokenExchange route here.
  protected override async onSigninInvokeActivity(context: TurnContext): Promise<void> {
    const value = context.activity.value as { token?: string } | undefined;
    const aadToken = value?.token;
    console.log(`[sso] invoke name=${context.activity.name} hasToken=${!!aadToken}`);
    if (aadToken) {
      try {
        const tenantId: string =
          (context.activity.channelData as { tenant?: { id?: string } } | undefined)?.tenant
            ?.id ?? '';
        const keycloakJwt = await exchangeAadForKeycloak(aadToken, tenantId);
        cacheToken(context.activity.from?.id ?? '', keycloakJwt);
        console.log('[sso] token cached for user', context.activity.from?.id);
        await context.sendActivity("You're signed in. What can I help you with?");
      } catch (err) {
        console.error('[CIPTeamsBot] SSO token exchange failed:', err);
        await context.sendActivity('Sign-in failed. Please try sending a message again.');
      }
    } else {
      console.warn('[sso] invoke received but no token in value:', JSON.stringify(value));
    }
  }
}
