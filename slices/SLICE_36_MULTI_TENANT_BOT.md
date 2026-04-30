# Slice 36 — Multi-Tenant Teams Bot (in-code tenant routing)

> **Prerequisite:** Slice 35 complete (tenants + tenant_identity_providers tables + `/admin/tenants/by-aad/:guid` endpoint).
> **Package:** `@cip/teams-bot`
> **Verify:** `pnpm --filter @cip/teams-bot typecheck && pnpm -r run typecheck`

---

## Why This Slice Exists

Teams bot architecture forces a **single endpoint** to receive messages from
all tenants that have installed the bot (one Azure AD app registration → one
`bot.idlevice.ca/api/messages` URL). The bot is currently single-realm — it
reads `KEYCLOAK_REALM` from env and uses one KC client secret for everything.

Slice 35 gave us the tenant ledger and a lookup endpoint. This slice teaches
the bot to use it: extract the AAD tenant ID from each incoming activity,
resolve which CIP tenant it belongs to, scope the rest of the message-handling
pipeline to that tenant, and reject messages from unknown or inactive tenants.

This is **defense-in-depth**: the AAD tenant ID lookup, the per-tenant KC
realm and secret, and the JWT `tenantId` claim are three independent checks.
A failure in any one is caught by the next layer.

---

## What You Are Building

```
packages/teams-bot/src/
  auth/
    tenant-resolver.ts                 ← NEW: AAD tenant ID → CIP tenant ID + realm + secret
    keycloak-secrets.ts                ← NEW: per-realm KC client secret loader
  bot.ts                               ← MODIFY: integrate tenant resolution into the pipeline
  helm/values.yaml                     ← MODIFY: KEYCLOAK_REALM removed; per-realm secrets
                                                  via KEYCLOAK_CLIENT_SECRETS map
```

No DB access added to the bot — it goes through hr-service's `GET /admin/tenants/by-aad/:guid`
(Slice 35 endpoint), with a small in-process cache.

---

## Read Before Writing

- `packages/teams-bot/src/bot.ts` (current single-realm pipeline)
- `packages/teams-bot/src/auth/token-store.ts` (in-memory cache pattern)
- `packages/teams-bot/src/auth/pending-message-store.ts` (similar in-memory cache)
- `packages/teams-bot/src/auth/resolve-context.ts` (current auth context shape)
- `packages/teams-bot/helm/values.yaml` (env vars to update)
- `slices/SLICE_35_TENANTS_AND_IDENTITY_PROVIDERS.md` § "HTTP Endpoints" (the lookup endpoint contract)

Do **not** read or modify hr-service. The endpoint is consumed via HTTP only.

---

## Hard Rules (Seven Non-Negotiables)

- `tenantId` extracted from `activity.channelData?.tenant?.id` is the AAD
  tenant ID, NOT the CIP tenant ID. They are different values; never conflate.
- The CIP tenant ID is resolved via the lookup endpoint and is the value
  used for: the KC realm name, JWT exchange, downstream MCP/DB scoping.
- Reject (drop the request, log a `[security]` line) if any check fails:
  no AAD tenant in activity, no matching CIP tenant, tenant not active,
  no enabled `aad_oidc` provider, no client secret available.
- Cache lookups in-memory for 5 minutes; eviction on cache miss only.
  The cache key is the AAD tenant ID.
- No `@anthropic-ai/sdk` imports.
- No raw NATS subjects (this slice doesn't publish events).
- Stubs forbidden — every function ships with a working body.

---

## The 6-step pipeline (replaces current bot's auth front-half)

```
Incoming activity (message or signin/tokenExchange)
   │
   ▼
1. Extract AAD tenant ID from activity.channelData.tenant.id
   if absent → drop, log [security] activity missing tenant.id
   │
   ▼
2. Resolve via hr-service GET /admin/tenants/by-aad/:aadTenantId
   (cached 5m). If 404 → drop, log [security] unknown tenant aadTenantId=X
   if returned tenant.status !== 'active' → drop, log [security] inactive tenant
   if returned provider.providerType !== 'aad_oidc' → drop (defensive)
   │
   ▼
3. Bind a TenantContext for THIS request:
     { aadTenantId, cipTenantId, realm, kcClientSecret }
   The cipTenantId === realm (one identifier).
   The kcClientSecret is loaded from KEYCLOAK_CLIENT_SECRETS map by realm name
   (see "Per-realm secrets" below). If not found → drop, log [security] missing secret.
   │
   ▼
4. JWT-AG token exchange uses ctx.realm + ctx.kcClientSecret
   (replaces current single-realm exchangeAadForKeycloak)
   │
   ▼
5. handleAuthenticatedMessage(context, ctx, kcJwt, text, attachments)
   - resolveAuthContext receives the same ctx (no re-derivation)
   - all logs include cipTenantId
   - all MCP calls send the per-tenant KC token
   │
   ▼
6. Server-side double-check is implicit:
   - hr-service MCP tools read tenantId from JWT and assert against any
     tenantId-bearing payload (none today; future-proof)
   - Postgres RLS scopes everything by JWT tenantId
   - These layers were not added in this slice — already in place
```

The 6 steps are sequential. Steps 1, 2, 3 happen on EVERY incoming activity
(message and signin/tokenExchange) before anything tenant-scoped runs.

---

## `auth/tenant-resolver.ts` (NEW)

```typescript
// In-memory tenant cache: aadTenantId → { cipTenantId, realm, kcClientSecret, expiresAt }
// 5-minute TTL. Single-shot eviction on miss; no background sweep needed.

export interface TenantContext {
  aadTenantId:     string;
  cipTenantId:     string;   // === realm name
  realm:           string;
  kcClientSecret:  string;
}

interface CachedEntry {
  ctx:        TenantContext;
  expiresAt:  number;
}

const TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, CachedEntry>();

interface LookupResponse {
  tenant:   { id: string; status: string };
  provider: {
    id:           string;
    tenantId:     string;
    providerType: string;
    alias:        string;
    enabled:      boolean;
    config:       Record<string, unknown>;
    secretRef:    string | null;
  };
}

export async function resolveTenantContext(
  aadTenantId: string,
): Promise<TenantContext | { error: string }> {
  if (!aadTenantId) return { error: 'no_aad_tenant_id' };

  const cached = cache.get(aadTenantId);
  if (cached && Date.now() < cached.expiresAt) return cached.ctx;

  const hrUrl = process.env['HR_SERVICE_URL'] ?? 'http://hr-service.cip-app.svc.cluster.local:3000';
  const adminToken = process.env['PLATFORM_ADMIN_TOKEN'] ?? '';
  if (!adminToken) return { error: 'platform_admin_token_unset' };

  const resp = await fetch(`${hrUrl}/admin/tenants/by-aad/${encodeURIComponent(aadTenantId)}`, {
    headers: { 'X-Platform-Admin-Token': adminToken },
  });
  if (resp.status === 404) return { error: 'unknown_tenant' };
  if (!resp.ok) return { error: `lookup_failed_${resp.status}` };

  const data = await resp.json() as LookupResponse;
  if (data.tenant.status !== 'active') return { error: 'inactive_tenant' };
  if (data.provider.providerType !== 'aad_oidc') return { error: 'wrong_provider_type' };
  if (!data.provider.enabled) return { error: 'provider_disabled' };

  const realm = data.tenant.id;
  const kcClientSecret = lookupKcSecret(realm);
  if (!kcClientSecret) return { error: 'missing_kc_client_secret' };

  const ctx: TenantContext = { aadTenantId, cipTenantId: realm, realm, kcClientSecret };
  cache.set(aadTenantId, { ctx, expiresAt: Date.now() + TTL_MS });
  return ctx;
}

// Helper imported from keycloak-secrets.ts (see below).
import { lookupKcSecret } from './keycloak-secrets.js';
```

---

## `auth/keycloak-secrets.ts` (NEW)

```typescript
// Per-realm KC client secrets are passed to the bot via a single env var
// KEYCLOAK_CLIENT_SECRETS containing a JSON map { "<realm>": "<secret>", ... }.
// Falls back to KEYCLOAK_CLIENT_SECRET (single-realm mode) for the realm
// named by KEYCLOAK_REALM_FALLBACK (defaults to 'cip-dev' for dev).

let _secrets: Record<string, string> | null = null;

function loadSecrets(): Record<string, string> {
  if (_secrets) return _secrets;
  const raw = process.env['KEYCLOAK_CLIENT_SECRETS'] ?? '';
  let map: Record<string, string> = {};
  if (raw) {
    try { map = JSON.parse(raw) as Record<string, string>; }
    catch { console.error('[kc-secrets] KEYCLOAK_CLIENT_SECRETS is not valid JSON'); }
  }
  // Backwards-compat: single secret + fallback realm name
  const single = process.env['KEYCLOAK_CLIENT_SECRET'] ?? '';
  const fallbackRealm = process.env['KEYCLOAK_REALM_FALLBACK'] ?? 'cip-dev';
  if (single && !map[fallbackRealm]) map[fallbackRealm] = single;

  _secrets = map;
  return map;
}

export function lookupKcSecret(realm: string): string | null {
  return loadSecrets()[realm] ?? null;
}
```

---

## `bot.ts` modifications

Replace the bot.ts SSO + onMessage logic with this shape (preserving the
pending-message + typing-indicator behaviour from Slice 30dcaba):

```typescript
this.onMessage(async (context, next) => {
  const userId = context.activity.from?.id ?? '';
  const aadTenantId = (context.activity.channelData as { tenant?: { id?: string } })?.tenant?.id ?? '';

  // Step 1 + 2: extract + resolve
  const ctxOrErr = await resolveTenantContext(aadTenantId);
  if ('error' in ctxOrErr) {
    console.warn(`[security] tenant resolution failed: ${ctxOrErr.error} aadTenantId="${aadTenantId}" userId="${userId}"`);
    await context.sendActivity('This bot is not configured for your organization.');
    await next(); return;
  }
  const ctx = ctxOrErr;

  // (existing token cache check)
  const keycloakJwt = getCachedToken(userId);
  if (!keycloakJwt) {
    // (existing pending-message stash + OAuthCard)
    // ...
    await next(); return;
  }

  await this.handleAuthenticatedMessage(context, ctx, keycloakJwt, /*text*/ ..., /*attachments*/ ...);
  await next();
});

protected override async onSigninInvokeActivity(context): Promise<void> {
  const aadTenantId = (context.activity.channelData as { tenant?: { id?: string } })?.tenant?.id ?? '';
  const ctxOrErr = await resolveTenantContext(aadTenantId);
  if ('error' in ctxOrErr) {
    console.warn(`[security] signin: tenant resolution failed: ${ctxOrErr.error} aadTenantId="${aadTenantId}"`);
    await context.sendActivity('Sign-in failed: organization not configured.');
    return;
  }
  const ctx = ctxOrErr;

  // (existing AAD token decode/log)
  // ...

  if (!aadToken) return;

  let kcJwt: string;
  try {
    kcJwt = await exchangeAadForKeycloak(aadToken, ctx);   // signature changed — see below
    cacheToken(context.activity.from?.id ?? '', kcJwt);
  } catch (err) {
    console.error('[CIPTeamsBot] SSO token exchange failed:', err);
    await context.sendActivity('Sign-in failed. Please try again.');
    return;
  }

  // (existing pending-message replay)
  const pending = takePendingMessage(context.activity.from?.id ?? '');
  if (pending) {
    await this.handleAuthenticatedMessage(context, ctx, kcJwt, pending.text, pending.fileAttachments);
  } else {
    await context.sendActivity('Signed in.');
  }
}

private async handleAuthenticatedMessage(
  context: TurnContext,
  ctx:     TenantContext,           // NEW parameter
  keycloakJwt: string,
  text:        string,
  fileAttachments: Attachment[],
): Promise<void> {
  // (existing typing indicator + tool routing, but tag every log line with ctx.cipTenantId)
}
```

The free function `exchangeAadForKeycloak` signature changes:

```typescript
async function exchangeAadForKeycloak(aadToken: string, ctx: TenantContext): Promise<string> {
  const keycloakBase = process.env['KEYCLOAK_URL'] ?? 'http://keycloak:8080';
  const url = `${keycloakBase}/auth/realms/${ctx.realm}/protocol/openid-connect/token`;
  const body = new URLSearchParams({
    grant_type:    'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion:     aadToken,
    client_id:     'teams-bot',
    client_secret: ctx.kcClientSecret,
    scope:         'openid',
  });
  // ... fetch + error handling unchanged
}
```

The KC realm + secret no longer come from env vars; both come from the
TenantContext bound at step 3.

---

## `resolveAuthContext` modification

The current `auth/resolve-context.ts` reads `tenantId` from
`channelData.tenant.id` (which is the AAD tenant ID — the wrong one). Update
it to take a `TenantContext` and use `ctx.cipTenantId` everywhere:

```typescript
export async function resolveAuthContext(
  context: TurnContext,
  ctx:     TenantContext,
  keycloakJwt: string,
): Promise<BotAuthContext> {
  const aadOid = ((context.activity.from as unknown) as Record<string, unknown>)['aadObjectId'] as string ?? '';
  const client = await getMcpClient(keycloakJwt);
  await client.callTool({ name: 'sync_employee', arguments: {} });
  const capsResult = await client.callTool({ name: 'get_employee_capabilities', arguments: {} });
  const capsResponse = JSON.parse(extractText(capsResult.content)) as {
    data?: { capabilities?: Record<string, boolean>; roles?: string[] };
  };
  return {
    tenantId:    ctx.cipTenantId,         // <— from TenantContext, not from activity
    userId:      context.activity.from?.id ?? '',
    employeeId:  aadOid,
    capabilities: capsResponse.data?.capabilities ?? {},
    roles:        capsResponse.data?.roles ?? [],
    bearerToken:  keycloakJwt,
    tenantConfig: {
      tenantId:           ctx.cipTenantId,
      name:               ctx.cipTenantId,
      litellmVirtualKey:  process.env['LITELLM_VIRTUAL_KEY'] ?? '',
      keycloakRealm:      ctx.realm,
      natsPrefix:         `cip.${ctx.cipTenantId}`,
      langfuseTags:       {},
    },
  };
}
```

---

## Helm values changes (`packages/teams-bot/helm/values.yaml`)

```yaml
env:
  # KEYCLOAK_REALM is no longer used by the bot — kept commented for ops note.
  # Per-realm KC client secrets via KEYCLOAK_CLIENT_SECRETS (JSON map).
  # During the dev/migration window, KEYCLOAK_CLIENT_SECRET still works for
  # the realm named by KEYCLOAK_REALM_FALLBACK (default cip-dev).
  KEYCLOAK_REALM_FALLBACK: cip-dev

  # New env vars for the lookup endpoint
  HR_SERVICE_URL: http://hr-service.cip-app.svc.cluster.local:3000
  # PLATFORM_ADMIN_TOKEN comes from envFrom secret

envFrom:
  - secretRef:
      name: teams-bot-credentials
```

The `teams-bot-credentials` K8s secret should now contain:
- `KEYCLOAK_CLIENT_SECRETS` — JSON map, e.g. `{"cip-dev":"abc123","<acme-uuid>":"xyz456"}`
- `KEYCLOAK_CLIENT_SECRET` — single-realm fallback (kept for now)
- `PLATFORM_ADMIN_TOKEN` — same value as on hr-service
- (existing) `BOT_APP_ID`, `BOT_APP_PASSWORD`, `AWS_*`

Document this in the slice's "manual ops" footnote — operators set
`KEYCLOAK_CLIENT_SECRETS` when adding a new tenant.

---

## Acceptance Criteria

- [ ] `auth/tenant-resolver.ts` exists, fetches via hr-service, caches 5m,
      returns either a `TenantContext` or `{error}` for every failure mode.
- [ ] `auth/keycloak-secrets.ts` parses `KEYCLOAK_CLIENT_SECRETS` JSON and
      falls back to `KEYCLOAK_CLIENT_SECRET` + `KEYCLOAK_REALM_FALLBACK` for
      single-realm dev mode.
- [ ] `bot.ts.onMessage` calls `resolveTenantContext` BEFORE any token check.
      Failure logs `[security] tenant resolution failed: <error>` and replies
      to the user with a generic "not configured" message.
- [ ] `bot.ts.onSigninInvokeActivity` calls `resolveTenantContext` BEFORE
      `exchangeAadForKeycloak`.
- [ ] `exchangeAadForKeycloak` no longer reads `KEYCLOAK_REALM` or
      `KEYCLOAK_CLIENT_SECRET` directly — all from `TenantContext`.
- [ ] `resolveAuthContext` accepts a `TenantContext` and uses
      `ctx.cipTenantId` everywhere (NOT `channelData.tenant.id`).
- [ ] All log lines in the message-handling pipeline include the
      `cipTenantId` (grepable for tenant-scoped debugging).
- [ ] Helm values surface the new env vars; the secret schema is documented.
- [ ] Bot reaches `[turn] discover=...` for messages from the `cip-dev`
      tenant (using KEYCLOAK_CLIENT_SECRET fallback path).
- [ ] Bot rejects messages from a Teams tenant with no matching
      `tenant_identity_providers.config->>'aad_tenant_id'` row, logging
      `[security] tenant resolution failed: unknown_tenant`.
- [ ] `pnpm --filter @cip/teams-bot typecheck` passes.
- [ ] `pnpm -r run typecheck` passes.

---

## Out of Scope

- Bot using KC's master/platform realm for the lookup auth (currently uses
  shared `PLATFORM_ADMIN_TOKEN` — same as Slice 35).
- Reconciliation of K8s secrets when a new tenant is provisioned —
  operator manually updates the `KEYCLOAK_CLIENT_SECRETS` map in the secret
  for now.
- Per-tenant LiteLLM virtual key resolution (the `tenantConfig.litellmVirtualKey`
  still comes from env). Future slice resolves per tenant via
  `tenant_settings`.
- Per-tenant ingress / per-tenant bot deployments. Single deployment serves
  all tenants.

---

## Cross-Slice Notes

If `resolveAuthContext`'s callers expect the `tenantConfig` shape to remain
unchanged, audit and either keep the field set or log a cross-slice note for
each consumer.

If the lookup endpoint Slice 35 specified isn't returning the exact shape
this slice's resolver expects, log a cross-slice note with the field
name/type difference rather than guessing.

If `BotAuthContext` is consumed elsewhere (e.g., the file-handler or MCP
client) and any of those callers reads `tenantId` to derive
`channelData.tenant.id`-like values, log a cross-slice note for each — they
need the value-change validated.

---

## Commit

```
slice(36): multi-tenant bot — AAD tenant resolution + per-realm KC secrets
```
