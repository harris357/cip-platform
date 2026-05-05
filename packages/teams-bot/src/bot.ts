import { randomUUID } from 'node:crypto';
import { TurnContext } from '@microsoft/agents-hosting';
import { Activity, type Attachment } from '@microsoft/agents-activity';
import { TeamsActivityHandler } from '@microsoft/agents-hosting-extensions-teams';
import { resolveAuthContext } from './auth/resolve-context.js';
import { cacheToken, getCachedToken } from './auth/token-store.js';
import { storePendingMessage, takePendingMessage } from './auth/pending-message-store.js';
import { resolveTenantContext, type TenantContext } from './auth/tenant-resolver.js';
import { updateChannelRegistry } from './teams-protocol/channel-registry.js';
import {
  detectFileAttachments,
  downloadAttachmentToBuffer,
  guessMimeType,
} from './teams-protocol/file-handler.js';
import { renderResponse } from './teams-protocol/card-renderer.js';
import { startProgressRenderer } from './teams-protocol/progress-renderer.js';
import { dispatchInvoke } from './teams-protocol/invoke-router.js';
import { sendResponseTime } from './intent/debug-banner.js';
import { executeTool } from './mcp/tool-executor.js';
import { discoverTools } from './mcp/tool-discovery.js';
import { runLangGraph } from './langgraph/runner.js';
import { dispatchSlashCommand } from './slash-commands/dispatch.js';
import { buildWelcomeChips } from './slash-commands/welcome-chips.js';

export function buildWelcomeMessage(): string {
  return (
    'Hello! I can help you manage certifications and HR tasks. ' +
    'Send me a message or upload a certificate document to get started.'
  );
}

/**
 * Slice 47: welcome message with suggestedActions chips. The chips are
 * universal because onMembersAdded fires before auth context exists.
 * Role-aware filtering happens once the user runs /help.
 */
export function buildWelcomeActivity(): Activity {
  return Activity.fromObject({
    type: 'message',
    text: 'Hello! I can help you manage certifications and HR tasks. Tap an option below or ask in your own words.',
    suggestedActions: { actions: buildWelcomeChips() },
  });
}

function getAadTenantId(context: TurnContext): string {
  return (context.activity.channelData as { tenant?: { id?: string } } | undefined)?.tenant?.id ?? '';
}

/**
 * Pull the documentId out of a `document_process` MCP response.
 * Tolerates the various shapes McpModuleResponse can take so the bot
 * doesn't fail the turn on a schema drift — worst case the progress
 * subscription is skipped and the user falls back to documents_status.
 */
function extractDocumentId(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const obj = result as Record<string, unknown>;
  const data = obj['data'];
  if (data && typeof data === 'object') {
    const id = (data as Record<string, unknown>)['documentId'];
    if (typeof id === 'string' && id.length > 0) return id;
  }
  const top = obj['documentId'];
  if (typeof top === 'string' && top.length > 0) return top;
  return null;
}

async function exchangeAadForKeycloak(aadToken: string, ctx: TenantContext): Promise<string> {
  const keycloakBase = process.env['KEYCLOAK_URL'] ?? 'http://keycloak:8080';
  const clientId = process.env['KEYCLOAK_CLIENT_ID'] ?? 'teams-bot';
  // Slice 56D follow-up: KEYCLOAK_URL now includes the /auth base path
  // (matches Keycloak Quarkus distribution layout). Don't double-add it
  // here — every other caller across the codebase already does the
  // direct `${base}/realms/...` form. This was the lone outlier.
  const url = `${keycloakBase}/realms/${ctx.realm}/protocol/openid-connect/token`;

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
          await context.sendActivity(buildWelcomeActivity());
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

    const tStart = Date.now();
    // Log the inbound message so any downstream log line ([classifier], [turn],
    // [auth-resolve], etc.) can be correlated back to what the user actually
    // typed. JSON.stringify escapes quotes/newlines safely; cap at 500 chars
    // to keep logs sane on long pastes.
    console.log(
      `[msg] tenantId=${tenantCtx.cipTenantId} files=${fileAttachments.length} text=${JSON.stringify(text.slice(0, 500))}`,
    );

    const threadId = context.activity.conversation?.id ?? 'unknown';

    // Tell Teams to render "<bot> is typing..." while we work.
    await context.sendActivity(Activity.fromObject({ type: 'typing' }));
    const tTyping = Date.now();

    const ctx = await resolveAuthContext(context, tenantCtx, keycloakJwt);
    const tAuth = Date.now();

    // Slice 47: slash command dispatch — runs AFTER auth resolution because
    // /help needs ctx.permissions to filter the registry. Slash commands
    // short-circuit before any LLM/runtime work.
    const slash = await dispatchSlashCommand({
      ctx,
      context,
      threadId,
      text,
    });
    if (slash) {
      // Slice 56F: when the handler returns a card, send it as an
      // attachment (text reply becomes the non-card-rendering fallback).
      if (slash.card) {
        await context.sendActivity(Activity.fromObject({
          type:        'message',
          ...(slash.reply ? { text: slash.reply } : {}),
          attachments: [
            { contentType: 'application/vnd.microsoft.card.adaptive', content: slash.card },
          ],
        }));
      } else {
        await context.sendActivity(slash.reply);
      }
      return;
    }

    await updateChannelRegistry(context, ctx.tenantId, ctx.bearerToken);
    const tRegistry = Date.now();

    // File-attachment fast path. Bot streams CDN bytes straight into
    // doc-service `document_process(...)` and subscribes to per-
    // conversation NATS progress events. Doc-service does the OVH
    // PutObject. Hard rule #3: bytes flow bot → doc-service → S3 once.
    //
    // (The legacy `documents.cert_legacy_path` branch was retired once
    // the new path was verified live.  hr-service still hosts the
    // `process_document` MCP tool — slice 58E removes it as part of the
    // cert workflow rewrite into a Route-A consumer.)
    if (fileAttachments.length > 0) {
      // Warm the multi-server tool catalog so executeTool routes
      // `document_process` to doc-service. discoverTools is cached 5-min
      // per (tenant, employee), so this is sub-ms after the first turn.
      try {
        await discoverTools(ctx);
      } catch (err) {
        console.warn(`[bot] tool catalog warmup failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      for (const file of fileAttachments) {
        const tDl0 = Date.now();
        const { buffer, mimeType, fileName } = await downloadAttachmentToBuffer(file);
        const tDl1 = Date.now();
        const conversationId = context.activity.conversation?.id ?? '';
        const sourceMessageId = context.activity.id;
        const args: Record<string, unknown> = {
          fileBase64: buffer.toString('base64'),
          fileName,
          mimeType:   guessMimeType(fileName, mimeType),
          ...(text ? { hintText: text } : {}),
          ...(sourceMessageId ? { sourceMessageId } : {}),
          ...(conversationId ? { conversationId } : {}),
        };
        const result = await executeTool('document_process', args, ctx);
        const tExec1 = Date.now();

        // Best-effort progress subscription. Failures don't block ack.
        const docId = extractDocumentId(result);
        if (docId && conversationId) {
          // Fire-and-forget: the renderer manages its own TTL + lifecycle.
          void startProgressRenderer(context, ctx.tenantId, conversationId, docId)
            .catch(err => console.warn(`[progress-renderer] start failed: ${err instanceof Error ? err.message : String(err)}`));
        }

        await renderResponse(context, result);
        await sendResponseTime(context, Date.now() - tStart, {
          tool:   'document_process',
          execMs: tExec1 - tDl1,
        });
        console.log(`[turn] tenantId=${ctx.tenantId} mode=file path=docservice file=${fileName} docId=${docId ?? '?'} typing=${tTyping - tStart}ms auth=${tAuth - tTyping}ms registry=${tRegistry - tAuth}ms download=${tDl1 - tDl0}ms exec=${tExec1 - tDl1}ms render=${Date.now() - tExec1}ms total=${Date.now() - tStart}ms`);
      }
      return;
    }

    // All non-file turns go through the LangGraph runtime. Slice 47b
    // removed the legacy classifier+router pipeline and the /lg toggle
    // — LangGraph is the only runtime now.
    await runLangGraph({ context, ctx, threadId, text, tStart });
  }

  // signin/failure is NOT routed through onSigninInvokeActivity — catch it here first.
  // Slice 53: `adaptiveCard/action` invokes route through the verb-dispatched
  // invoke router BEFORE falling through to `super.onInvokeActivity`. The
  // router returns null on miss, so unmatched verbs (none today; future
  // cards may add more without re-touching this method) and signin/* both
  // continue to work. The router is purely additive.
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
    if (context.activity.name === 'adaptiveCard/action') {
      try {
        const result = await dispatchInvoke(context);
        if (result) {
          return { status: result.statusCode, body: result.body };
        }
      } catch (err) {
        // A handler threw. Surface a 500 so Teams logs it; the user
        // sees the original card stay in place. Don't crash the
        // adapter; let other invoke types (signin/*, future verbs)
        // keep working.
        console.error(`[invoke-router] handler threw: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
        return { status: 500 };
      }
      // No handler matched → fall through to default. The default
      // `onAdaptiveCardInvoke` returns 501 unless overridden.
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
      // Teams sends signin/tokenExchange twice per OAuthCard (two AAD tokens
      // with different iat). The first replays the pending message; the
      // second arrives after pending was cleared. Stay silent — sending
      // "Signed in." here surfaces a confusing second message AFTER the bot
      // has already replied to the user's actual question.
      console.log(`[sso] duplicate tokenExchange (no pending message) userId=${userId} — staying silent`);
    }
  }
}
