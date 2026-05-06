import type { AuthContext } from './types.js'
import { InvalidJwtError } from './types.js'

// Slice 67: pure JWT-claim extraction. No network, no cache, no permission
// resolution. The caller (resolveAuthContext) wraps this with verify + remote
// resolve + cache.

export interface JwtClaims {
  tenantId:     string
  keycloakSub:  string
  email:        string
  fullName:     string
  givenName:    string | null
  surname:      string | null
  aadOid:       string | null
  realmRoles:   string[]
  rawToken:     string
}

/**
 * Decode a JWT (no verify) and extract canonical claims. Use only after
 * verifyJwt has already succeeded — this assumes the payload is trusted.
 */
export function extractClaims(payload: Record<string, unknown>, rawToken: string): JwtClaims {
  const tenantId = payload['tenantId']
  const sub      = payload['sub']
  if (typeof tenantId !== 'string' || !tenantId) {
    throw new InvalidJwtError('missing tenantId claim')
  }
  if (typeof sub !== 'string' || !sub) {
    throw new InvalidJwtError('missing sub claim')
  }

  const email    = pickString(payload, 'email') ?? pickString(payload, 'preferred_username')
  const fullName = pickString(payload, 'name') ?? email
  if (!email)    throw new InvalidJwtError('missing email / preferred_username claim')
  if (!fullName) throw new InvalidJwtError('missing name claim')

  const realmAccess = (payload['realm_access'] as { roles?: unknown } | undefined) ?? {}
  const realmRoles = Array.isArray(realmAccess.roles)
    ? (realmAccess.roles as unknown[]).filter((r): r is string => typeof r === 'string')
    : []

  return {
    tenantId,
    keycloakSub: sub,
    email,
    fullName,
    givenName:   pickString(payload, 'given_name'),
    surname:     pickString(payload, 'family_name'),
    aadOid:      pickString(payload, 'oid'),
    realmRoles,
    rawToken,
  }
}

function pickString(payload: Record<string, unknown>, key: string): string | null {
  const v = payload[key]
  return typeof v === 'string' && v.length > 0 ? v : null
}

/**
 * Decode-only (no verify) helper for callers that have already verified.
 */
export function extractAuthContextUnverified(rawToken: string): JwtClaims {
  if (!rawToken) throw new InvalidJwtError('empty token')
  const parts = rawToken.split('.')
  if (parts.length !== 3) throw new InvalidJwtError('not a JWT (expected 3 segments)')
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf-8'))
  } catch {
    throw new InvalidJwtError('payload not valid base64url JSON')
  }
  return extractClaims(payload, rawToken)
}

/** Returns just the AuthContext-relevant subset (no aadOid, no roles split). */
export function claimsToAuthContextStub(claims: JwtClaims): Pick<AuthContext, 'userId' | 'tenantId' | 'keycloakSub' | 'email' | 'fullName' | 'roles' | 'rawToken'> {
  // userId left empty — the resolver fills it from /auth/resolve.
  return {
    userId:      '',
    tenantId:    claims.tenantId,
    keycloakSub: claims.keycloakSub,
    email:       claims.email,
    fullName:    claims.fullName,
    roles:       claims.realmRoles,
    rawToken:    claims.rawToken,
  }
}
