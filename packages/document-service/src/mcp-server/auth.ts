// Slice 67: doc-service uses @cip/auth. The previously stubbed
// `assertPermission` now goes via @cip/auth → platform-core /auth/resolve
// (cached 5 min). Identity extraction stays a thin local helper for the
// edge cases where a tool only needs tenant/sub/roles without a network
// hit (e.g., debug logging).

import {
  resolveAuthContext,
  assertPermission as authAssertPermission,
  PermissionDeniedError as AuthPermissionDeniedError,
} from '@cip/auth'

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

// Re-export so callers can `import { PermissionDeniedError } from '../mcp-server/auth.js'`
// without changing import paths post-67.
export { AuthPermissionDeniedError as PermissionDeniedError }

/**
 * Slice 67: real permission check via @cip/auth. resolveAuthContext does
 * local JWT decode + cached remote permission resolve via platform-core.
 * Throws PermissionDeniedError if the required code isn't in the resolved
 * permission list.
 */
export async function assertPermission(
  authInfo: { token: string } | undefined,
  required: string,
): Promise<void> {
  if (!authInfo?.token) throw new Error('Missing bearer token in MCP auth context')
  const ctx = await resolveAuthContext(authInfo.token)
  authAssertPermission(ctx, required)
}
