import { createHash } from 'node:crypto'
import { extractAuthContextUnverified } from './extract-auth-context.js'
import {
  type AuthContext,
  type AuthResolveResponse,
  PermissionDeniedError,
  PlatformCoreUnreachableError,
  UserNotFoundError,
  InvalidJwtError,
  JwtExpiredError,
} from './types.js'

// Slice 67: cached remote permission resolve. The CR in L+CR.
//
// Each service calls resolveAuthContext(token) once per request. First call
// hits platform-core /auth/resolve; subsequent calls within AUTH_CACHE_TTL_MS
// return the cached AuthContext.
//
// Cache key: SHA-256 of the raw token. Cleaner than storing tokens directly.

const CACHE_TTL_MS = parseInt(process.env['AUTH_CACHE_TTL_MS'] ?? '300000', 10) // 5 min

interface CacheEntry {
  ctx:       AuthContext
  expiresAt: number
}

const cache = new Map<string, CacheEntry>()

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 32)
}

function platformCoreUrl(): string {
  return process.env['PLATFORM_CORE_URL']
    ?? 'http://platform-core.cip-app.svc.cluster.local:3001'
}

/**
 * Look up the caller's AuthContext: validates JWT (locally verify happens
 * via verifyJwt — but is NOT mandatory for this resolver, the
 * platform-core endpoint also verifies; pass-through is fine if the local
 * verify is omitted in low-stakes contexts), then asks platform-core for
 * permissions. Caches the answer.
 *
 * For services that need to enforce local verify before remote resolve,
 * call verifyJwt(token, jwksUrl) before this. For services that trust the
 * JWT was verified upstream (e.g., MCP transport already ran a middleware),
 * call this directly.
 */
export async function resolveAuthContext(
  rawToken: string,
  options: { bypassCache?: boolean } = {},
): Promise<AuthContext> {
  if (!rawToken) throw new InvalidJwtError('empty token')

  const key = tokenHash(rawToken)
  if (!options.bypassCache) {
    const cached = cache.get(key)
    if (cached && Date.now() < cached.expiresAt) {
      return cached.ctx
    }
  }

  // Decode claims (local, fast; no signature verify here — platform-core does that)
  const claims = extractAuthContextUnverified(rawToken)

  // Remote resolve
  const url = `${platformCoreUrl()}/auth/resolve${options.bypassCache ? '?bypass_cache=true' : ''}`
  let resp: Response
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${rawToken}` },
    })
  } catch (err) {
    throw new PlatformCoreUnreachableError(err instanceof Error ? err.message : String(err))
  }

  if (resp.status === 401) {
    const body = (await resp.json().catch(() => ({}))) as { error?: string }
    if (body.error === 'jwt_expired')   throw new JwtExpiredError()
    if (body.error === 'user_not_found') throw new UserNotFoundError(claims.tenantId, claims.keycloakSub)
    throw new InvalidJwtError(body.error ?? 'unknown')
  }
  if (!resp.ok) {
    throw new PlatformCoreUnreachableError(`HTTP ${resp.status}`)
  }

  const body = (await resp.json()) as AuthResolveResponse
  const ctx: AuthContext = {
    userId:      body.userId,
    tenantId:    body.tenantId,
    keycloakSub: claims.keycloakSub,
    permissions: body.permissions,
    roles:       body.roles,
    email:       body.email,
    fullName:    body.fullName,
    rawToken,
  }
  cache.set(key, { ctx, expiresAt: Date.now() + CACHE_TTL_MS })
  return ctx
}

/**
 * Glob-aware permission check. Throws PermissionDeniedError if the
 * required code is not in the resolved permission list. Globs are
 * EXPANDED on the platform-core side (using cip_platform.permission_catalog)
 * so callers see literal codes here.
 */
export function assertPermission(ctx: AuthContext, required: string): void {
  if (ctx.permissions.includes(required)) return
  // Glob support: catalog *should* expand globs server-side, but accept
  // pattern matches as a safety net.
  for (const granted of ctx.permissions) {
    if (granted === '*') return
    if (granted.endsWith('.*')) {
      const prefix = granted.slice(0, -2) + '.'
      if (required.startsWith(prefix)) return
    }
  }
  throw new PermissionDeniedError(required)
}

/** Test-only / admin tools: nuke the cache. */
export function clearAuthCache(): void {
  cache.clear()
}
