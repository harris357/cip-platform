// Slice 66: minimal MCP auth context extractor for platform-core. Mirrors
// hr-service/src/mcp-server/auth.ts but without permission resolution
// (platform-core does not own the permission catalog yet — slice 67/68).

export interface PlatformMcpAuthContext {
  tenantId:     string
  keycloakSub:  string
  email:        string
  fullName:     string
  givenName:    string | null
  surname:      string | null
  aadOid:       string | null
}

export function extractAuthContext(authInfo: { token: string } | undefined): PlatformMcpAuthContext {
  if (!authInfo?.token) throw new Error('Missing bearer token in MCP auth context')
  const parts = authInfo.token.split('.')
  if (parts.length !== 3) throw new Error('Invalid JWT format')
  const payloadJson = Buffer.from(parts[1]!, 'base64url').toString('utf-8')
  const payload = JSON.parse(payloadJson) as Record<string, unknown>

  const tenantId = payload['tenantId']
  const sub      = payload['sub']
  if (typeof tenantId !== 'string' || !tenantId)
    throw new Error('JWT missing tenantId claim — check Keycloak Protocol Mapper')
  if (typeof sub !== 'string' || !sub)
    throw new Error('JWT missing sub claim')

  const email      = pickString(payload, 'email') ?? pickString(payload, 'preferred_username')
  const fullName   = pickString(payload, 'name') ?? email
  const givenName  = pickString(payload, 'given_name')
  const surname    = pickString(payload, 'family_name')
  const aadOid     = pickString(payload, 'oid')

  if (!email)    throw new Error('JWT missing email / preferred_username claim')
  if (!fullName) throw new Error('JWT missing name claim')

  return {
    tenantId,
    keycloakSub: sub,
    email,
    fullName,
    givenName: givenName ?? null,
    surname:   surname   ?? null,
    aadOid:    aadOid    ?? null,
  }
}

function pickString(payload: Record<string, unknown>, key: string): string | null {
  const v = payload[key]
  return typeof v === 'string' && v.length > 0 ? v : null
}
