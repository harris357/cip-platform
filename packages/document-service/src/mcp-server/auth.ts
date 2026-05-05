// Slice 58A — JWT extraction + permission check stub.
//
// extractAuthContext mirrors hr-service exactly: parses Keycloak JWT,
// returns {tenantId, employeeId, roles}.  Pulled into doc-service as
// a copy (not imported from hr-service per slice rule "no dependency
// on hr-service code").  Future workspace cleanup can promote this to
// @cip/shared.
//
// assertPermission is a STUB.  58A introduces no MCP tools, so the
// stub is never invoked at runtime.  58B+ replaces it with the real
// delegation pattern (HTTP call to hr-service's permission check
// endpoint, JWT-forwarded).

export interface DocServiceAuthContext {
  tenantId:    string
  employeeId:  string
  roles:       string[]
}

export function extractAuthContext(authInfo: { token: string } | undefined): DocServiceAuthContext {
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

  const realmAccess = (payload['realm_access'] as { roles?: unknown } | undefined) ?? {}
  const realmRoles  = Array.isArray(realmAccess.roles) ? (realmAccess.roles as string[]) : []
  const flatRoles   = Array.isArray(payload['roles']) ? (payload['roles'] as string[]) : []

  return {
    tenantId,
    employeeId: sub,
    roles: Array.from(new Set([...realmRoles, ...flatRoles])),
  }
}

export class PermissionDeniedError extends Error {
  readonly code = 'permission_denied'
  constructor(public readonly required: string) {
    super(`Permission denied: missing '${required}'`)
    this.name = 'PermissionDeniedError'
  }
}

/**
 * Stub — replaced in 58B with HTTP delegation to hr-service.  Per
 * Non-Negotiable #7 stubs throw "not implemented" rather than return
 * undefined as any; 58A registers no MCP tools so this is never
 * invoked at runtime.
 */
export async function assertPermission(
  _authInfo: { token: string } | undefined,
  required: string,
): Promise<void> {
  throw new Error(`assertPermission not implemented (slice 58A — required='${required}')`)
}
