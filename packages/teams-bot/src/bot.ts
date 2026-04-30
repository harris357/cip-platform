import { randomUUID } from 'node:crypto';
import { TurnContext } from '@microsoft/agents-hosting';
import { Activity, type Attachment } from '@microsoft/agents-activity';
import { TeamsActivityHandler } from '@microsoft/agents-hosting-extensions-teams';
import type { Tool as McpTool } from '@modelcontextprotocol/sdk/types.js';
import { resolveAuthContext } from './auth/resolve-context.js';
import { cacheToken, getCachedToken } from './auth/token-store.js';
import { storePendingMessage, takePendingMessage } from './auth/pending-message-store.js';
import { resolveTenantContext, type TenantContext } from './auth/tenant-resolver.js';
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

function getAadTenantId(context: TurnContext): string {
  return (context.activity.channelData as { tenant?: { id?: string } } | undefined)?.tenant?.id ?? '';
}

async function exchangeAadForKeycloak(aadToken: string, ctx: TenantContext): Promise<string> {
  const keycloakBase = process.env['KEYCLOAK_URL'] ?? 'http://keycloak:8080';
  const clientId = process.env['KEYCLOAK_CLIENT_ID'] ?? 'teams-bot';
  const url = `${keycloakBase}/auth/realms/${ctx.realm}/protocol/openid-connect/token`;

  const body = new URLSearchParams({
    grant_type:    'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion:     aadToken,
    client_id:     clientId,
    client_secret: ctx.kcClientSecret,
    scope:         'openid',
  });

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!response.ok) {
    throw new Error(`Keycloak token exchange failed (realm=${ctx.realm}): ${response.status} ${await response.text()}`);
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
      const aadTenantId = getAadTenantId(context);

      // Step 1+2 of the multi-tenant pipeline: extract + resolve AAD tenant.
      // Failures drop the request with a [security] log line.
      const ctxOrErr = await resolveTenantContext(aadTenantId);
      if ('error' in ctxOrErr) {
        console.warn(`[security] tenant resolution failed: ${ctxOrErr.error} aadTenantId="${aadTenantId}" userId="${userId}"`);
        await context.sendActivity('This bot is not configured for your organization.');
        await next();
        return;
      }
      const tenantCtx = ctxOrErr;

      const keycloakJwt = getCachedToken(userId);

      if (!keycloakJwt) {
        // No token — stash the user's message so we can replay it after SSO,
        // then send the OAuthCard. Teams intercepts it, silently acquires an
        // AAD token, and sends signin/tokenExchange to onSigninInvokeActivity.
        const text = context.activity.text?.trim() ?? '';
        const fileAttachments = detectFileAttachments(context);
        if (text || fileAttachments.length > 0) {
          storePendingMessage(userId, { text, fileAttachments });
        }

        const resourceUri = `api://botid-${process.env['BOT_APP_ID'] ?? ''}`;
        console.log(`[auth] no cached token tenantId=${tenantCtx.cipTenantId} userId=${userId} — initiating Teams SSO, resource=${resourceUri}`);
        await context.sendActivity(Activity.fromObject({
          type: 'message',
          attachments: [{
            contentType: 'application/vnd.microsoft.card.oauth',
            content: {
              connectionName: 'sso',
              title: 'Sign in to CIP',
              text: 'Verifying your identity — this happens once per session.',
              tokenExchangeResource: {
                id: randomUUID(),
                uri: resourceUri,
              },
            },
          }],
        }));
        await next();
        return;
      }

      await this.handleAuthenticatedMessage(
        context,
        tenantCtx,
        keycloakJwt,
        context.activity.text?.trim() ?? '',
        detectFileAttachments(context),
      );
      await next();
    });
  }

  // Shared message-handling pipeline. Called from onMessage (normal flow) and
  // from onSigninInvokeActivity (replaying the message captured before SSO).
  private async handleAuthenticatedMessage(
    context: TurnContext,
    tenantCtx: TenantContext,
    keycloakJwt: string,
    text: string,
    fileAttachments: Attachment[],
  ): Promise<void> {
    if (!text && fileAttachments.length === 0) return;

    // Tell Teams to render "<bot> is typing..." while we work.
    await context.sendActivity(Activity.fromObject({ type: 'typing' }));

    const ctx = await resolveAuthContext(context, tenantCtx, keycloakJwt);
    await updateChannelRegistry(context, ctx.tenantId, ctx.bearerToken);

    if (fileAttachments.length > 0) {
      for (const file of fileAttachments) {
        const t0 = Date.now();
        const key = await downloadToObjectStore(file, ctx);
        const result = await executeTool('process_document', { objectStoreKey: key }, ctx);
        console.log(`[turn] tenantId=${ctx.tenantId} file=${file.name ?? '?'} executeTool=${Date.now() - t0}ms`);
        await renderResponse(context, result);
      }
      return;
    }

    const tDiscover = Date.now();
    const tools = await discoverTools(ctx);
    const tRoute = Date.now();
    const selected = await routeIntent(text, tools, ctx);
    const tExec = Date.now();

    if (selected) {
      const result = await executeTool(selected.name, selected.args, ctx);
      console.log(`[turn] tenantId=${ctx.tenantId} discover=${tRoute - tDiscover}ms route=${tExec - tRoute}ms exec=${Date.now() - tExec}ms tool=${selected.name}`);
      await renderResponse(context, result);
    } else {
      console.log(`[turn] tenantId=${ctx.tenantId} discover=${tRoute - tDiscover}ms route=${tExec - tRoute}ms exec=- (no tool match)`);
      await context.sendActivity(buildNoToolMessage(tools));
    }
  }

  // signin/failure is NOT routed through onSigninInvokeActivity — catch it here first.
  protected override async onInvokeActivity(context: TurnContext): Promise<{ status: number; body?: unknown }> {
    if (context.activity.name === 'signin/failure') {
      const err = context.activity.value as { code?: string; message?: string } | undefined;
      console.error(`[sso] signin/failure: ${JSON.stringify(err)}`);
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
        const [, payloadB64] = aadToken.split('.');
        const payload = JSON.parse(Buffer.from(payloadB64 ?? '', 'base64url').toString('utf8')) as {
          aud?: string; iss?: string; sub?: string; oid?: string;
          tid?: string; ver?: string; scp?: string; iat?: number; exp?: number;
        };
        const iatAge = payload.iat ? Math.round(Date.now() / 1000 - payload.iat) : null;
        console.log(`[sso] token claims: sub="${payload.sub}" oid="${payload.oid}" aud="${payload.aud}" iss="${payload.iss}" tid="${payload.tid}" ver="${payload.ver}" scp="${payload.scp}" iat_age=${iatAge}s exp_in=${payload.exp ? payload.exp - Math.round(Date.now() / 1000) : null}s`);
      } catch {
        console.warn('[sso] could not decode token JWT');
      }
    }

    if (!aadToken) {
      console.warn('[sso] invoke received but no token in value:', JSON.stringify(value));
      return;
    }

    const userId = context.activity.from?.id ?? '';
    const aadTenantId = getAadTenantId(context);

    // Same step 1+2 gate as onMessage: every signin path resolves the tenant
    // before touching the JWT.
    const ctxOrErr = await resolveTenantContext(aadTenantId);
    if ('error' in ctxOrErr) {
      console.warn(`[security] signin: tenant resolution failed: ${ctxOrErr.error} aadTenantId="${aadTenantId}" userId="${userId}"`);
      await context.sendActivity('Sign-in failed: organization not configured.');
      return;
    }
    const tenantCtx = ctxOrErr;

    let keycloakJwt: string;
    try {
      keycloakJwt = await exchangeAadForKeycloak(aadToken, tenantCtx);
      cacheToken(userId, keycloakJwt);
      console.log(`[sso] token cached tenantId=${tenantCtx.cipTenantId} userId=${userId}`);
    } catch (err) {
      console.error('[CIPTeamsBot] SSO token exchange failed:', err);
      await context.sendActivity('Sign-in failed. Please try sending a message again.');
      return;
    }

    // Replay the message captured before SSO, so the user's first question
    // gets a real answer instead of a "you're signed in" filler message.
    const pending = takePendingMessage(userId);
    if (pending) {
      await this.handleAuthenticatedMessage(
        context, tenantCtx, keycloakJwt, pending.text, pending.fileAttachments,
      );
    } else {
      // Edge case: SSO completed without a pending message.
      await context.sendActivity('Signed in.');
    }
  }
}
