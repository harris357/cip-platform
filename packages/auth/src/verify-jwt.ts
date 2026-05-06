import { jwtVerify } from 'jose'
import { getJwksResolver } from './jwks-cache.js'
import { InvalidJwtError, JwtExpiredError } from './types.js'

// Slice 67: local JWT verify against KC JWKS. The L in L+CR.
//
// Returns the decoded payload on success. Throws typed errors on failure.

export interface VerifiedJwt {
  payload: Record<string, unknown>
  rawToken: string
}

export async function verifyJwt(rawToken: string, jwksUrl: string): Promise<VerifiedJwt> {
  if (!rawToken) throw new InvalidJwtError('empty token')
  const parts = rawToken.split('.')
  if (parts.length !== 3) throw new InvalidJwtError('not a JWT (expected 3 segments)')

  const resolver = getJwksResolver(jwksUrl)
  try {
    const { payload } = await jwtVerify(rawToken, resolver)
    return { payload: payload as Record<string, unknown>, rawToken }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.toLowerCase().includes('expired')) throw new JwtExpiredError()
    throw new InvalidJwtError(msg)
  }
}

/**
 * Compute the JWKS URL for a Keycloak realm. The bot's tenant resolver
 * already knows the realm; pass through here.
 */
export function buildKeycloakJwksUrl(keycloakUrl: string, realm: string): string {
  return `${keycloakUrl.replace(/\/$/, '')}/realms/${encodeURIComponent(realm)}/protocol/openid-connect/certs`
}
