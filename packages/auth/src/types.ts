// Slice 67: shared auth types. Returned shape from platform-core /auth/resolve
// and from @cip/auth's resolveAuthContext (after local-verify + cached-resolve).

export interface AuthContext {
  /** cip_platform.users.id (UUID) */
  userId:      string
  /** cip_platform.tenants.id (UUID); also the JWT's tenantId claim */
  tenantId:    string
  /** Subject from JWT. For Keycloak: the KC user uuid. */
  keycloakSub: string
  /** Permission codes (literals + globs expanded). */
  permissions: string[]
  /** Realm roles from realm_access.roles. */
  roles:       string[]
  /** Email from JWT (preferred_username fallback). */
  email:       string
  /** Display name; full_name claim or email fallback. */
  fullName:    string
  /** Raw JWT for downstream forwarding. */
  rawToken:    string
}

export interface AuthResolveResponse {
  userId:      string
  tenantId:    string
  permissions: string[]
  roles:       string[]
  email:       string
  fullName:    string
}

export type AuthResolveErrorCode =
  | 'invalid_jwt'
  | 'jwt_expired'
  | 'unknown_tenant'
  | 'user_not_found'
  | 'platform_core_unreachable'

export class InvalidJwtError extends Error {
  readonly code: 'invalid_jwt' | 'jwt_expired' = 'invalid_jwt'
  constructor(reason: string) {
    super(`Invalid JWT: ${reason}`)
    this.name = 'InvalidJwtError'
  }
}

export class JwtExpiredError extends Error {
  readonly code = 'jwt_expired' as const
  constructor() {
    super('JWT expired')
    this.name = 'JwtExpiredError'
  }
}

export class UserNotFoundError extends Error {
  readonly code = 'user_not_found' as const
  constructor(public readonly tenantId: string, public readonly keycloakSub: string) {
    super(`User not found in tenant ${tenantId} for keycloak sub ${keycloakSub}`)
    this.name = 'UserNotFoundError'
  }
}

export class PermissionDeniedError extends Error {
  readonly code = 'permission_denied' as const
  constructor(public readonly required: string) {
    super(`Permission denied: missing '${required}'`)
    this.name = 'PermissionDeniedError'
  }
}

export class PlatformCoreUnreachableError extends Error {
  readonly code = 'platform_core_unreachable' as const
  constructor(reason: string) {
    super(`platform-core unreachable: ${reason}`)
    this.name = 'PlatformCoreUnreachableError'
  }
}
