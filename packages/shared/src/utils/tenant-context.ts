import { jwtVerify, createRemoteJWKSet } from 'jose';
import type { AuthContext, TenantContext, TenantConfig } from '../types/tenant.js';
import type { Request, Response, NextFunction, RequestHandler } from 'express';

const KEYCLOAK_URL = process.env['KEYCLOAK_URL'] ?? 'http://keycloak-keycloakx.cip-auth.svc.cluster.local';
const KEYCLOAK_REALM = process.env['KEYCLOAK_REALM'] ?? 'cip-dev';

const JWKS = createRemoteJWKSet(new URL(
  `${KEYCLOAK_URL}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/certs`,
));

// Express middleware — verifies Bearer JWT and attaches AuthContext to req.
// AuthContext = TenantContext + roles[] (from JWT realm_access.roles).
// tenantId is ALWAYS extracted from the JWT, never from request body or params.
export async function tenantAuthMiddleware(
  req: Request & { tenantContext?: AuthContext },
  res: Response,
  next: NextFunction,
): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing Bearer token' });
    return;
  }

  const token = authHeader.slice(7);
  try {
    const { payload } = await jwtVerify(token, JWKS);
    const tenantId = payload['tenantId'] as string | undefined;
    const userId = payload['sub'] as string | undefined;

    if (!tenantId) {
      res.status(401).json({ error: 'JWT missing tenantId claim — check Keycloak Protocol Mapper' });
      return;
    }

    // Slice 32: extract realm_access.roles from the JWT. Default to [] if
    // missing or malformed — only requireRealmRole cares, and it 403s if the
    // required role isn't there.
    const realmAccess = payload['realm_access'] as { roles?: unknown } | undefined;
    const roles: string[] = Array.isArray(realmAccess?.roles)
      ? (realmAccess!.roles as unknown[]).filter((r): r is string => typeof r === 'string')
      : [];

    const tenantConfig: TenantConfig = {
      tenantId,
      name: tenantId,
      litellmVirtualKey: '',
      keycloakRealm: KEYCLOAK_REALM,
      natsPrefix: `cip.${tenantId}`,
      langfuseTags: {},
    };

    req.tenantContext = { tenantId, userId: userId ?? '', tenantConfig, roles };
    next();
  } catch (_err) {
    res.status(401).json({ error: 'Invalid or expired JWT' });
  }
}

// Slice 32: Express middleware that 403s if the authenticated user does not
// have the required realm role. tenantAuthMiddleware must run before this
// (req.tenantContext.roles is the source of truth).
//
// Single-role-per-call by design. Compose for AND-of-roles by chaining:
//   router.use(requireRealmRole('hr'), requireRealmRole('admin'))
// For OR-of-roles, a separate requireAnyRealmRole helper can be added when
// a real caller needs it — don't speculatively add it now.
export function requireRealmRole(role: string): RequestHandler {
  return (
    req: Request & { tenantContext?: AuthContext },
    res: Response,
    next: NextFunction,
  ): void => {
    if (!req.tenantContext?.roles?.includes(role)) {
      res.status(403).json({ error: 'forbidden', missingRole: role });
      return;
    }
    next();
  };
}

// Extracts AuthContext from a request that has passed through tenantAuthMiddleware.
// Throws if tenantId is missing — this is a hard requirement.
export function extractTenantContext(req: Request & { tenantContext?: AuthContext }): TenantContext {
  if (req.tenantContext) return req.tenantContext;
  const payload = (req as unknown as Record<string, unknown>)['jwtPayload'] as Record<string, unknown> | undefined;
  if (!payload?.['tenantId']) throw new Error('Missing tenantId in JWT payload');
  return {
    tenantId: payload['tenantId'] as string,
    userId: (payload['sub'] as string | undefined) ?? '',
    tenantConfig: payload['tenantConfig'] as TenantConfig,
  };
}

// Convenience wrapper for async operations that need a tenant context
export async function withTenantContext<T>(
  ctx: TenantContext,
  fn: (ctx: TenantContext) => Promise<T>,
): Promise<T> {
  return fn(ctx);
}
