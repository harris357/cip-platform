import { createRemoteJWKSet, type JWTVerifyGetKey } from 'jose'

// Slice 67: lazy JWKS resolution per (issuer/realm). Holds onto jose's
// RemoteJWKSet which handles HTTP-fetch + key-rotation refetch on `kid`
// mismatch internally.

const JWKS_TTL_MS = parseInt(process.env['JWKS_TTL_MS'] ?? '3600000', 10) // 1 hour

const cache = new Map<string, JWTVerifyGetKey>()

/**
 * Returns a jose-compatible key resolver function for the given JWKS URL.
 * Caches per URL — same realm reuses the same key set.
 *
 * Typical KC JWKS URL: `${KEYCLOAK_URL}/realms/${realm}/protocol/openid-connect/certs`
 */
export function getJwksResolver(jwksUrl: string): JWTVerifyGetKey {
  const existing = cache.get(jwksUrl)
  if (existing) return existing
  const resolver = createRemoteJWKSet(new URL(jwksUrl), {
    cacheMaxAge:    JWKS_TTL_MS,
    cooldownDuration: 30_000,    // re-fetch on kid miss after 30s, no flood
  })
  cache.set(jwksUrl, resolver)
  return resolver
}

/** Test-only: drop the cache. */
export function _resetJwksCache(): void {
  cache.clear()
}
