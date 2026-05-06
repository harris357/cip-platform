// Slice 67: @cip/auth — canonical JWT verify + permission resolution for
// every service. L+CR pattern: Local verify (each service via JWKS cache),
// Cached Remote resolve (platform-core /auth/resolve with 5-min cache).

export {
  type AuthContext,
  type AuthResolveResponse,
  type AuthResolveErrorCode,
  InvalidJwtError,
  JwtExpiredError,
  UserNotFoundError,
  PermissionDeniedError,
  PlatformCoreUnreachableError,
} from './types.js'

export { verifyJwt, buildKeycloakJwksUrl, type VerifiedJwt } from './verify-jwt.js'
export { getJwksResolver, _resetJwksCache } from './jwks-cache.js'
export {
  extractClaims,
  extractAuthContextUnverified,
  claimsToAuthContextStub,
  type JwtClaims,
} from './extract-auth-context.js'
export {
  resolveAuthContext,
  assertPermission,
  clearAuthCache,
} from './auth-resolver.js'
