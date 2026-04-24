import { jwtVerify, createRemoteJWKSet } from 'jose';
import type { TenantContext, TenantConfig } from '../types/tenant.js';
import type { Request, Response, NextFunction } from 'express';

const KEYCLOAK_URL = process.env['KEYCLOAK_URL'] ?? 'https://keycloak.dev.cip.io';
const KEYCLOAK_REALM = process.env['KEYCLOAK_REALM'] ?? 'cip-dev';

const JWKS_URL = `${KEYCLOAK_URL}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/certs`;
const JWKS = createRemoteJWKSet(new URL(JWKS_URL));

/**
 * Express middleware that validates the Bearer JWT and attaches TenantContext to req.
 * tenantId is ALWAYS extracted from the JWT — never from request body or params.
 */
export async function withTenantContext(
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
    const userId   = payload['sub'] as string | undefined;

    if (!tenantId) {
      res.status(401).json({ error: 'JWT missing tenantId claim — check Keycloak Protocol Mapper' });
      return;
    }

    // Stub until tenant-config service is wired — hydrate from DB/cache in a later slice.
    const tenantConfig: TenantConfig = {
      tenantId,
      name: tenantId,
      litellmVirtualKey: '',
      keycloakRealm: KEYCLOAK_REALM,
      natsPrefix: `cip.${tenantId}`,
      langfuseTags: {},
    };

    req.tenantContext = {
      tenantId,
      userId: userId ?? '',
      tenantConfig,
    };

    next();
  } catch (_err) {
    res.status(401).json({ error: 'Invalid or expired JWT' });
  }
}
