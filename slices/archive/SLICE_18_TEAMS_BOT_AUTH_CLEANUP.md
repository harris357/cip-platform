# Slice 18 — Teams Bot: SSO Auth Flow + Code Cleanup

> **Prerequisite:** Slice 17 complete (teams-bot scaffold in place).
> **Package:** `@cip/teams-bot`
> **Verify:** `pnpm --filter @cip/teams-bot typecheck`

---

## What You Are Fixing

Slice 17 produced a working scaffold but left four problems that block real deployment:

1. **`mcp/client.ts` has a syntax error** — `erport` instead of `export`. The file will not compile.
2. **`agents/intent-router/` and `handlers/` are orphaned** — not imported by `bot.ts`, reference
   types that do not exist (`CertUploadedEvent`, `Subjects.certUploaded`). Both directories are
   pre-MCP scaffold from the original design doc; the MCP-based `intent/router.ts` supersedes them.
3. **SSO token flow is broken** — `resolveAuthContext` reads the AAD token from
   `context.activity.value.token`, which only exists on `signin/tokenExchange` invoke activities.
   Regular user messages never carry a token there. Every real message throws and the bot dies.
4. **Helm values are missing required env vars** — `MCP_SERVER_URL`, `BOT_APP_ID`, `KEYCLOAK_CLIENT_ID`,
   `KEYCLOAK_CLIENT_SECRET` are consumed at runtime but not surfaced in `values.yaml` or the secret ref.

---

## Read Before Writing

- `packages/teams-bot/src/bot.ts`
- `packages/teams-bot/src/auth/resolve-context.ts`
- `packages/teams-bot/src/mcp/client.ts`
- `packages/teams-bot/helm/values.yaml`
- `packages/teams-bot/helm/templates/deployment.yaml`

Do NOT read `hr-service` or `shared` packages beyond confirming that `BotAuthContext` and
`AuthContext` are already defined correctly.

---

## Files to Delete

Remove these directories entirely — they are dead code:

```
packages/teams-bot/src/agents/     (agents/intent-router/index.ts + schema.ts)
packages/teams-bot/src/handlers/   (cert-upload.handler.ts, compliance-query.handler.ts, hitl-response.handler.ts)
```

---

## Files to Create

```
packages/teams-bot/src/auth/token-store.ts    ← NEW: in-memory SSO token cache
```

---

## Files to Modify

```
packages/teams-bot/src/mcp/client.ts          ← fix erport typo
packages/teams-bot/src/bot.ts                 ← add SSO flow handlers
packages/teams-bot/src/auth/resolve-context.ts ← accept token directly, not from activity
packages/teams-bot/helm/values.yaml           ← add missing env var stubs
```

---

## `auth/token-store.ts` — New File

```typescript
// In-memory SSO token cache: userId → { keycloakJwt, expiresAt }
// Tokens are stored after signin/tokenExchange and retrieved on every message.
// TTL matches Keycloak access token lifetime (default: 5 minutes).
// In a multi-replica deployment, replace with Redis; in-memory is fine for now.

interface TokenEntry {
  keycloakJwt: string;
  expiresAt: number;  // Date.now() + TTL
}

const TOKEN_TTL_MS = 5 * 60 * 1000;
const store = new Map<string, TokenEntry>();

export function cacheToken(userId: string, keycloakJwt: string): void {
  store.set(userId, { keycloakJwt, expiresAt: Date.now() + TOKEN_TTL_MS });
}

export function getCachedToken(userId: string): string | null {
  const entry = store.get(userId);
  if (!entry || Date.now() > entry.expiresAt) {
    store.delete(userId);
    return null;
  }
  return entry.keycloakJwt;
}

export function evictToken(userId: string): void {
  store.delete(userId);
}
```

---

## `auth/resolve-context.ts` — Changes

Change `resolveAuthContext` to accept the Keycloak JWT directly rather than extracting
the AAD token itself. The bot now owns the full SSO flow; `resolve-context` only builds
the `BotAuthContext` from a token that is already in hand.

Remove `resolveAadToken` and `exchangeAadForKeycloak` from public scope — they move to
`bot.ts` where they belong to the SSO state machine.

Keep `exchangeAadForKeycloak` as a module-private function in `bot.ts` (shown below).

New signature for `resolveAuthContext`:

```typescript
export async function resolveAuthContext(
  context: TurnContext,
  keycloakJwt: string,
): Promise<BotAuthContext>
```

Implementation stays the same from the jwt parameter downward
(get MCP client, call `get_employee_capabilities`, build and return `BotAuthContext`).
Remove the `resolveAadToken` call and the `exchangeAadForKeycloak` call from inside this
function — those now live in `bot.ts`.

---

## `bot.ts` — SSO State Machine

The bot must handle three distinct activity types. Add these to the constructor in
`CIPTeamsBot`, alongside the existing `onMembersAdded` and `onMessage` handlers.

### 1. `onTeamsTokenExchangeInvoke` — receive the SSO token

Teams calls this when it silently obtains an AAD token for the user (triggered by the
`webApplicationInfo` section in the manifest). The bot exchanges it for a Keycloak JWT
and caches it.

```typescript
this.onTeamsSigninVerifyState(async (context, next) => {
  // Teams SSO silent flow succeeded — exchange AAD token for Keycloak JWT
  const aadToken = (context.activity.value as { token?: string } | undefined)?.token;
  if (aadToken) {
    try {
      const tenantId: string =
        (context.activity.channelData as { tenant?: { id?: string } } | undefined)?.tenant?.id ?? '';
      const keycloakJwt = await exchangeAadForKeycloak(aadToken, tenantId);
      cacheToken(context.activity.from.id, keycloakJwt);
    } catch (err) {
      console.error('[CIPTeamsBot] SSO token exchange failed:', err);
    }
  }
  await next();
});
```

### 2. Modify `onMessage` — check cache before proceeding

At the top of `onMessage`, look up the cached Keycloak JWT for the user. If not found,
send a sign-in trigger card (one plain-text message is sufficient) and return.

```typescript
this.onMessage(async (context: TurnContext, next) => {
  const userId = context.activity.from.id;
  let keycloakJwt = getCachedToken(userId);

  if (!keycloakJwt) {
    // Token cache miss — prompt the user to trigger SSO
    // Teams will automatically re-run the silent token exchange and call
    // onTeamsSigninVerifyState, which populates the cache.
    await context.sendActivity(
      'Please wait a moment while I verify your identity...',
    );
    await next();
    return;
  }

  const ctx = await resolveAuthContext(context, keycloakJwt);
  await updateChannelRegistry(context, ctx.tenantId, ctx.bearerToken);

  // ... rest of existing message handler (file attachments, intent routing)
```

### 3. Move `exchangeAadForKeycloak` into `bot.ts`

Cut the function from `resolve-context.ts` and paste it as a module-private function
in `bot.ts`. It is only called during the SSO token exchange — `resolve-context.ts`
no longer needs it.

### Imports to add to `bot.ts`

```typescript
import { cacheToken, getCachedToken } from './auth/token-store.js';
```

---

## `mcp/client.ts` — Fix Typo

Line 1: change `erport { Client }` to `import { Client }`.

---

## `helm/values.yaml` — Missing Env Vars

Add the following entries to the `env:` block. Values shown are defaults/stubs;
real values must be supplied via the `teams-bot-credentials` K8s Secret (for secrets)
or overridden at deploy time (for URLs).

```yaml
env:
  # existing keys remain unchanged
  LITELLM_BASE_URL: http://litellm.cip-app.svc.cluster.local:4000
  NATS_URL: nats://nats.cip-infra.svc.cluster.local:4222
  KEYCLOAK_URL: https://keycloak.dev.cip.io
  KEYCLOAK_REALM: cip-dev
  # new keys — stubs; override at deploy time or via secret
  MCP_SERVER_URL: http://hr-service.cip-app.svc.cluster.local:4001/mcp
  KEYCLOAK_CLIENT_ID: teams-bot
```

The following must be added to the `teams-bot-credentials` K8s Secret (not
hardcoded in values.yaml):
- `BOT_APP_ID` — Azure Bot registration app ID
- `BOT_APP_PASSWORD` — Azure Bot registration client secret
- `KEYCLOAK_CLIENT_SECRET` — Keycloak `teams-bot` client secret

Document this requirement at the top of `helm/values.yaml` as a comment:

```yaml
# Required K8s Secret: teams-bot-credentials
# Keys: BOT_APP_ID, BOT_APP_PASSWORD, KEYCLOAK_CLIENT_SECRET
# Object store keys added in Slice 19: OBJECT_STORE_BUCKET, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
```

---

## Hard Rules

1. The bot never imports from `@cip/hr-service`
2. `tenantId` never comes from bot configuration — always from Teams channelData or JWT
3. No hardcoded tenant IDs, channel IDs, or role names in the bot
4. `resolveAuthContext` receives a Keycloak JWT — it does not call `exchangeAadForKeycloak` itself
5. Token cache is keyed by Teams `activity.from.id` (stable per user, per conversation)

---

## Acceptance Criteria

- [ ] `packages/teams-bot/src/agents/` directory deleted
- [ ] `packages/teams-bot/src/handlers/` directory deleted
- [ ] `mcp/client.ts` compiles (typo fixed)
- [ ] `auth/token-store.ts` exists with `cacheToken`, `getCachedToken`, `evictToken`
- [ ] `bot.ts` handles `onTeamsSigninVerifyState` — caches Keycloak JWT on success
- [ ] `bot.ts` `onMessage` reads from token cache; sends soft prompt if cache miss
- [ ] `resolveAuthContext` accepts `keycloakJwt: string` parameter — not read from activity
- [ ] `helm/values.yaml` includes `MCP_SERVER_URL`, `KEYCLOAK_CLIENT_ID` as plain env vars
- [ ] `helm/values.yaml` comment documents the `teams-bot-credentials` secret keys
- [ ] `pnpm --filter @cip/teams-bot typecheck` passes
