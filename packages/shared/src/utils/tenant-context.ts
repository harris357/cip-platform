import { jwtVerify, createRemoteJWKSet } from 'jose';
import type { TenantContext, TenantConfig } from '../types/tenant.js';
import type { Request, Response, NextFunction } from 'express';

const KEYCLOAK_URL = process.env['KEYCLOAK_URL'] ?? 'http://keycloak-keycloakx.cip-auth.svc.cluster.local';
const KEYCLOAK_REALM = process.env['KEYCLOAK_REALM'] ?? 'cip-dev';

const JWKS = createRemoteJWKSet(new URL(
  `${KEYCLOAK_URL}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/certs`,
));

// Express middleware — verifies Bearer JWT and attaches TenantContext to req
// tenantId is ALWAYS extracted from the JWT, never from request body or params
export async function tenantAuthMiddleware(
  req: Request & { tenantContext?: TenantContext },
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

    const tenantConfig: TenantConfig = {
      tenantId,
      name: tenantId,
      litellmVirtualKey: '',
      keycloakRealm: KEYCLOAK_REALM,
      natsPrefix: `cip.${tenantId}`,
      langfuseTags: {},
    };

    req.tenantContext = { tenantId, userId: userId ?? '', tenantConfig };
    next();
  } catch (_err) {
    res.status(401).json({ error: 'Invalid or expired JWT' });
  }
}

// Extracts TenantContext from a request that has passed through tenantAuthMiddleware
// Throws if tenantId is missing — this is a hard requirement
export function extractTenantContext(req: Request & { tenantContext?: TenantContext }): TenantContext {
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
