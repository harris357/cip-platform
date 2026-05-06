# Slice 67 — `@cip/auth` package + platform-core `/auth/resolve` endpoint

> **Why this exists:** Phase 5 of Arc 1. Today every service that needs auth re-implements its own JWT decode + permission resolution. hr-service has [auth.ts](packages/hr-service/src/mcp-server/auth.ts); document-service has a near-identical [auth.ts](packages/document-service/src/mcp-server/auth.ts) with `assertPermission` stubbed (`throw new Error('not implemented')`). Slice 67 introduces a single canonical implementation in `@cip/auth` and a centralized `/auth/resolve` endpoint on platform-core. doc-service flips from stubbed to real auth.
>
> **Locked pattern (D5 from the migration plan):** L+CR — **L**ocal JWT verify (each service has KC's JWKS cached) + **C**ached **R**emote permission resolve (each service calls platform-core's `/auth/resolve`, caches result for 5 min per token). Local verify is free; remote resolve is amortized.
>
> **Scoped narrowly:** hr-service keeps its existing local auth.ts for slice 67. Migrating it to `@cip/auth` is a follow-up after slice 67 proves the pattern in doc-service. This avoids touching ~20 hr-service files in the same slice.

---

## Files in scope

```
# ── @cip/auth package (NEW) ─────────────────────────────────────────────
packages/auth/package.json                                                NEW (~25 LOC — declares @cip/auth, peer-dep on jose for JWT verify)
packages/auth/tsconfig.json                                                NEW (extends tsconfig.base.json)
packages/auth/src/index.ts                                                 NEW (~15 LOC — re-export surface)
packages/auth/src/extract-auth-context.ts                                  NEW (~80 LOC — JWT decode + claim extraction)
packages/auth/src/jwks-cache.ts                                            NEW (~60 LOC — fetch + cache KC public keys via jose)
packages/auth/src/verify-jwt.ts                                            NEW (~50 LOC — local RSA verify against cached JWKS)
packages/auth/src/auth-resolver.ts                                         NEW (~100 LOC — calls platform-core /auth/resolve with 5-min in-memory cache per token)
packages/auth/src/types.ts                                                 NEW (~40 LOC — AuthContext, AuthResolveResponse types)

pnpm-workspace.yaml                                                        MOD (already includes packages/* glob — verify)

# ── platform-core /auth/resolve endpoint ────────────────────────────────
packages/platform-core/src/routes/auth.ts                                  NEW (~120 LOC — POST /auth/resolve; verifies JWT, looks up user, resolves permissions cross-schema from cip_hr.permission_groups)
packages/platform-core/src/server.ts                                      MOD (mount authRouter)

# ── document-service uses @cip/auth ─────────────────────────────────────
packages/document-service/package.json                                     MOD (+ @cip/auth: workspace:*)
packages/document-service/src/mcp-server/auth.ts                           MOD (replaces stubbed assertPermission; uses @cip/auth's resolver)
```

~500 LOC of new code. hr-service untouched.

---

## Hard rules

1. **Local JWT verify only.** Each service caches Keycloak's JWKS at startup via `jwks-cache.ts`. RSA-verifies tokens locally. Refreshes JWKS on key rotation (kid mismatch triggers refetch).

2. **Cached remote permission resolve.** `@cip/auth` includes a 5-min in-memory cache keyed by token. On cache miss, POSTs to platform-core `/auth/resolve` with the bearer token, gets `{userId, tenantId, permissions, roles}`, caches result. On cache hit, returns cached value without network call.

3. **`bypass_cache=true` query param** on `/auth/resolve` for security-sensitive callers. Permission revocation lag is up to 5 min for cached lookups; admin tools that grant/revoke roles can call with `bypass_cache=true` immediately after the change.

4. **`/auth/resolve` is the platform-core endpoint** that resolves permissions. It reads from `cip_platform.users` + `cip_platform.user_identity_links` + cross-schema from `cip_hr.permission_groups`/`role_groups`/`employee_role_assignments`. Slice 68 moves these tables to cip_platform; slice 67 cross-schema reads them.

5. **doc-service is the test bed.** Its previously-stubbed `assertPermission` becomes real. Any tool that requires a permission (currently the eval module's three tools per slice 60) hits @cip/auth → platform-core `/auth/resolve` → cached permissions.

6. **hr-service unchanged.** Its local auth.ts continues to work. A future slice migrates it to @cip/auth (small, focused). This boundary keeps slice 67 small and reduces risk of bot-turn regressions.

7. **No magic numbers.** Cache TTL (`AUTH_CACHE_TTL_MS`, default 5 min) and JWKS refresh interval (`JWKS_TTL_MS`, default 1 hour) are env-configurable.

8. **Sane error envelope.** `/auth/resolve` returns 401 with structured error code: `invalid_jwt | jwt_expired | unknown_tenant | user_not_found`. Service-side `@cip/auth` maps these to typed errors (`InvalidJwtError`, `UserNotFoundError`, etc.) that callers can pattern-match.

---

## `@cip/auth` API

```typescript
// @cip/auth/index.ts
export { extractAuthContext } from './extract-auth-context.js'
export { verifyJwt } from './verify-jwt.js'
export { resolveAuthContext, clearAuthCache } from './auth-resolver.js'
export { assertPermission } from './assert-permission.js'
export {
  type AuthContext,
  type AuthResolveResponse,
  type AuthResolveError,
  InvalidJwtError,
  UserNotFoundError,
  PermissionDeniedError,
} from './types.js'
```

Service-side usage:

```typescript
// In a doc-service MCP tool handler:
import { resolveAuthContext, assertPermission } from '@cip/auth'

const ctx = await resolveAuthContext(authInfo.token)
await assertPermission(ctx, 'documents.admin.eval')
// ctx.userId, ctx.tenantId, ctx.permissions, ctx.roles available
```

`resolveAuthContext` does:
1. JWT decode + local signature verify (cheap, sync)
2. Cache lookup by token hash
3. On miss: POST to platform-core `/auth/resolve` (cluster-internal HTTP; cached client)
4. Returns typed `AuthContext`

---

## platform-core `/auth/resolve` — endpoint shape

```
POST /auth/resolve
Authorization: Bearer <kc-jwt>
Query: ?bypass_cache=true (optional)

Response 200:
{
  userId: "uuid",
  tenantId: "uuid",
  permissions: ["cert.submit", "cert.view_own", ...],
  roles: ["hr", "employee", ...]
}

Response 401:
{ error: "invalid_jwt" | "jwt_expired" | "unknown_tenant" | "user_not_found" }
```

Implementation:
1. Local JWT verify via JWKS (server-side cache, same lib as @cip/auth)
2. Look up `user_identity_links.user_id` by (tenantId, 'keycloak', sub)
3. Cross-schema resolve permissions: `cip_hr.employee_role_assignments` → `cip_hr.role_groups` → `cip_hr.permission_groups` → glob-expand against `cip_platform.permission_catalog`
4. Realm roles from JWT claim
5. Return JSON

`bypass_cache=true` is informational on the endpoint side (the cache is on the client/service side); the server always reads fresh.

---

## doc-service: stubbed → real

`packages/document-service/src/mcp-server/auth.ts`:

```typescript
// BEFORE:
export async function assertPermission(authInfo, required) {
  throw new Error('not implemented')
}

// AFTER (slice 67):
import { resolveAuthContext, assertPermission as authPermissionCheck } from '@cip/auth'

export async function assertPermission(
  authInfo: { token: string } | undefined,
  required: string,
): Promise<void> {
  if (!authInfo?.token) throw new Error('Missing bearer token')
  const ctx = await resolveAuthContext(authInfo.token)
  await authPermissionCheck(ctx, required)
}
```

Slice 60's eval tools (`eval_classifier_summary`, etc.) immediately get real permission checks against `documents.admin.eval`.

---

## Acceptance criteria

1. **`pnpm install` clean** after `@cip/auth` workspace add.

2. **`pnpm -r run typecheck` clean.**

3. **`@cip/auth` builds** — `dist/index.js`, `dist/types.d.ts` etc. present.

4. **platform-core `/auth/resolve` returns 200** with valid AuthContext for a valid JWT in a known tenant. 401 with structured error for invalid/expired tokens or unknown users.

5. **doc-service `assertPermission` no longer throws "not implemented"**. Calling `eval_classifier_summary` with a token that has `documents.admin.eval` succeeds; without it, returns 403/permission_denied (the `assertPermission` throws).

6. **JWKS cached and refreshed** — first JWT verify fetches JWKS from KC; subsequent verifies use cache; cache refreshes on `kid` mismatch.

7. **Auth cache hits/misses logged** — service logs include `[auth-cache] hit token=<hash>` / `miss → resolved in Xms` per request, so operators can observe cache effectiveness.

8. **Permission cache TTL respected** — second call within 5 min uses cache; beyond TTL, re-resolves.

9. **`bypass_cache=true` works** — admin script can force a fresh resolve.

10. **hr-service unchanged** — `pnpm --filter @cip/hr-service test` passes; no auth.ts file modified.

---

## Test plan

- **Unit (`@cip/auth`)**:
  - `extractAuthContext` with happy / missing tenantId / missing sub
  - `verifyJwt` with valid signature / wrong signature / expired
  - `resolveAuthContext` cache hit / miss / TTL expiry
  - `assertPermission` for literal match, glob match, denial

- **Unit (platform-core /auth/resolve)**:
  - Valid token + provisioned user → 200 with permissions
  - Valid token + un-provisioned user → 401 user_not_found
  - Invalid signature → 401 invalid_jwt
  - Expired → 401 jwt_expired

- **Integration**:
  - doc-service eval tool against authorized user → 200
  - doc-service eval tool against unauthorized user → permission_denied
  - hr-service flow regression: send a Teams message; resolve-context still works (uses local auth, not @cip/auth)

---

## Forward refs

- **Slice 68 — Permission ownership migration**. Moves `roles`, `permission_groups`, `role_groups`, `user_role_assignments` from `cip_hr` to `cip_platform`. Slice 67's `/auth/resolve` cross-schema query becomes a same-schema query.
- **Future slice — Migrate hr-service to `@cip/auth`**. Replaces hr-service's local auth.ts with @cip/auth. ~20 file imports change. Touches the bot's hot path; deserves its own slice.
- **Future slice — Per-tenant JWKS caching**. Today JWKS is per-realm; if multi-realm-per-pod ever lands, cache key shifts to (realm, kid).

---

## Risks

- **Risk**: every doc-service tool call now does an HTTP roundtrip on cache miss. Slice 60's eval tools are infrequent; impact is small. But the pattern locks in network dep.
  - **Mitigation**: 5-min cache amortizes. If platform-core has an outage, eval tools fail closed (correct behavior; readers can't read without auth).

- **Risk**: cross-schema permission resolution in `/auth/resolve` ties platform-core to cip_hr's permission tables. Slice 68 fixes this; slice 67 lives with it.
  - **Mitigation**: documented as cross-slice work. Same-DB cross-schema query is cheap.

- **Risk**: JWKS fetch needs network at startup. If KC is unreachable, doc-service can't process auth.
  - **Mitigation**: fetch lazily on first request; retry on transient failure. Match production patterns.

- **Risk**: cache TTL of 5 min lags admin permission changes. A user just granted a role won't see it until cache expires.
  - **Mitigation**: admin grant tools call `/auth/resolve?bypass_cache=true` for the affected user immediately after the change. Documented in admin-employees.ts updates (post-slice-67 cleanup).

- **Risk**: hr-service's continued use of local auth means two patterns coexist. Devs may grep "extractAuthContext" and find both.
  - **Mitigation**: documented as transitional. Future slice consolidates.

---

## Implementation status

**Implemented in commit-pending state on 2026-05-06.** Files touched:

**`@cip/auth` (NEW package):**
- `packages/auth/package.json` — `jose: ^6.2.3`, `@types/node`
- `packages/auth/tsconfig.json` — extends base
- `packages/auth/src/types.ts` — `AuthContext`, error classes (`InvalidJwtError`, `JwtExpiredError`, `UserNotFoundError`, `PermissionDeniedError`, `PlatformCoreUnreachableError`)
- `packages/auth/src/jwks-cache.ts` — `getJwksResolver(jwksUrl)` via jose's `createRemoteJWKSet`; 1-hour TTL configurable
- `packages/auth/src/verify-jwt.ts` — `verifyJwt(token, jwksUrl)` local RSA verify, `buildKeycloakJwksUrl(kcUrl, realm)` helper
- `packages/auth/src/extract-auth-context.ts` — `extractClaims`, `extractAuthContextUnverified`, `claimsToAuthContextStub`
- `packages/auth/src/auth-resolver.ts` — `resolveAuthContext(token, {bypassCache?})` with 5-min in-memory cache keyed by SHA-256 of token; `assertPermission(ctx, required)` with glob expansion fallback; `clearAuthCache()` test helper
- `packages/auth/src/index.ts` — public API surface

**platform-core (new):**
- `packages/platform-core/src/routes/auth.ts` — `POST /auth/resolve` endpoint. Verifies JWT against KC JWKS (issuer-derived), looks up user via `cip_platform.user_identity_links`, cross-schema-resolves permissions from `cip_hr.{employee_role_assignments, role_groups, permission_groups}`, glob-expands against `cip_platform.permission_catalog`. Returns AuthResolveResponse JSON or structured 401 error.

**platform-core (modified):**
- `packages/platform-core/package.json` — adds `@cip/auth: workspace:*`
- `packages/platform-core/src/server.ts` — mounts `authRouter` between admin tenants and MCP server

**document-service (modified):**
- `packages/document-service/package.json` — adds `@cip/auth: workspace:*`
- `packages/document-service/src/mcp-server/auth.ts` — `assertPermission` no longer stubbed; calls `resolveAuthContext` from `@cip/auth` and runs the glob-aware check. `extractAuthContext` left as a thin local helper for callers that don't need a network hit. `PermissionDeniedError` re-exported from `@cip/auth` so existing imports keep working.

**Verification:**
- ✅ `pnpm install` clean
- ✅ `pnpm -r run typecheck` clean (all 7 packages)
- ✅ `pnpm -r run build` clean — `packages/auth/dist/{index.js,types.d.ts,...}` present
- ⏳ Runtime: needs platform-core deployed with the new route + a valid JWT to exercise; doc-service eval tools (slice 60) become permission-checked end-to-end.

## Locked decisions

1. **L+CR pattern** — local JWT verify + cached remote permission resolve. Per migration plan D5.
2. **`@cip/auth` package new home** for the canonical implementation. Use `jose` for JWT verify (zero-dep, ESM-native).
3. **doc-service is the test bed**. hr-service unchanged in slice 67.
4. **Cache TTL 5 min**, env override `AUTH_CACHE_TTL_MS`. JWKS TTL 1 hour, env override `JWKS_TTL_MS`.
5. **Cross-schema permission resolution** in `/auth/resolve` — temporary until slice 68 moves permissions into cip_platform.

Slice is locked. Proceeding to implementation.
