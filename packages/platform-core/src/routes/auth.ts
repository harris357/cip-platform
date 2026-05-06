import { Router, type IRouter, type Request, type Response } from 'express'
import { getPool, getDb } from '../db/index.js'
import { eq, and } from 'drizzle-orm'
import { users, userIdentityLinks, permissionCatalog } from '../db/schema.js'
import {
  verifyJwt,
  buildKeycloakJwksUrl,
  extractClaims,
  InvalidJwtError,
  JwtExpiredError,
} from '@cip/auth'

// Slice 67: POST /auth/resolve — JWT verify + permission resolution.
// Bearer token in Authorization header. Returns AuthResolveResponse with
// expanded permissions (literals + globs from cip_platform.permission_catalog).
//
// Cross-schema reads from cip_hr.{employee_role_assignments,role_groups,
// permission_groups} until slice 68 moves them to cip_platform.

export const authRouter: IRouter = Router()

interface ResolvedRow {
  p: string
}
interface RoleRow {
  code: string
}

authRouter.post('/auth/resolve', async (req: Request, res: Response): Promise<void> => {
  const auth = req.header('authorization') ?? ''
  if (!auth.startsWith('Bearer ')) {
    res.status(401).json({ error: 'invalid_jwt', detail: 'missing bearer token' })
    return
  }
  const token = auth.slice('Bearer '.length).trim()

  // 1. Verify JWT against KC JWKS for the realm encoded in the token.
  //    The realm name lives in the iss claim; for KC: `${KEYCLOAK_URL}/realms/${realm}`.
  let payload: Record<string, unknown>
  try {
    const decoded = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf-8')) as Record<string, unknown>
    const iss = decoded['iss']
    if (typeof iss !== 'string') throw new InvalidJwtError('missing iss claim')
    // Derive JWKS URL from issuer. Issuer is `${KEYCLOAK_URL}/realms/${realm}`.
    const jwksUrl = `${iss}/protocol/openid-connect/certs`
    const verified = await verifyJwt(token, jwksUrl)
    payload = verified.payload
  } catch (err) {
    if (err instanceof JwtExpiredError) {
      res.status(401).json({ error: 'jwt_expired' })
      return
    }
    if (err instanceof InvalidJwtError) {
      res.status(401).json({ error: 'invalid_jwt', detail: err.message })
      return
    }
    res.status(401).json({ error: 'invalid_jwt', detail: 'verify failed' })
    return
  }

  // 2. Extract canonical claims.
  const claims = extractClaims(payload, token)

  // 3. Look up user via the canonical keycloak link.
  const db = getDb()
  const linkRows = await db
    .select({
      userId:    users.id,
      email:     users.email,
      fullName:  users.fullName,
    })
    .from(userIdentityLinks)
    .innerJoin(users, eq(users.id, userIdentityLinks.userId))
    .where(and(
      eq(userIdentityLinks.tenantId, claims.tenantId),
      eq(userIdentityLinks.provider, 'keycloak'),
      eq(userIdentityLinks.subject,  claims.keycloakSub),
    ))
    .limit(1)

  if (linkRows.length === 0) {
    res.status(401).json({ error: 'user_not_found' })
    return
  }
  const userRow = linkRows[0]!

  // 4. Resolve permissions cross-schema.
  //    Slice 67 caveat: roles + groups still live in cip_hr. Slice 68 moves
  //    them; this query becomes single-schema then.
  const pool = getPool()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [claims.tenantId])

    // Slice 68: authorization tables moved to cip_platform — single-schema query.
    const permRes = await client.query<ResolvedRow>(
      `SELECT DISTINCT jsonb_array_elements_text(pg.permissions) AS p
         FROM cip_platform.user_role_assignments ura
         JOIN cip_platform.role_groups rg       ON rg.role_id = ura.role_id
         JOIN cip_platform.permission_groups pg ON pg.id      = rg.group_id
        WHERE ura.user_id = $1`,
      [userRow.userId],
    )
    const raw = permRes.rows.map(r => r.p)

    let permissions: string[]
    const globs    = raw.filter(p => p.endsWith('*'))
    const literals = raw.filter(p => !p.endsWith('*'))
    if (globs.length === 0) {
      permissions = Array.from(new Set(literals)).sort()
    } else {
      // Glob expansion against cip_platform.permission_catalog. Catalog is
      // populated at hr-service startup (slice 42A); empty until that runs.
      const catalogRes = await client.query<{ code: string }>(
        `SELECT (service || '.' || permission) AS code FROM cip_platform.permission_catalog`,
      )
      const allKnown = catalogRes.rows.map(r => r.code).map(c => {
        // The catalog stores `service`, `module`, `permission` separately; the
        // permission column is already prefixed (e.g., 'cert.submit'). Use
        // permission column directly.
        return c
      })
      // Re-fetch the right shape (just permission codes — no service prefix)
      const codeRes = await client.query<{ permission: string }>(
        `SELECT permission FROM cip_platform.permission_catalog`,
      )
      const codes = codeRes.rows.map(r => r.permission)
      const expanded = new Set<string>(literals)
      for (const g of globs) {
        if (g === '*') {
          codes.forEach(p => expanded.add(p))
        } else {
          const prefix = g.slice(0, -1)
          codes.filter(p => p.startsWith(prefix)).forEach(p => expanded.add(p))
        }
      }
      permissions = Array.from(expanded).sort()
      void allKnown
    }

    const roleRes = await client.query<RoleRow>(
      `SELECT r.code
         FROM cip_platform.user_role_assignments ura
         JOIN cip_platform.roles r ON r.id = ura.role_id
        WHERE ura.user_id = $1
        ORDER BY r.code`,
      [userRow.userId],
    )

    await client.query('COMMIT')

    // realm roles come from JWT, not DB
    const realmRoles = claims.realmRoles

    res.json({
      userId:      userRow.userId,
      tenantId:    claims.tenantId,
      permissions,
      // Combine realm roles (JWT) + platform roles (DB) in one list. Some
      // checks (like `requireRealmRole('hr')`) want JWT roles; permission
      // resolution above already handled the platform-role expansion.
      roles:       Array.from(new Set([...realmRoles, ...roleRes.rows.map(r => r.code)])),
      email:       userRow.email,
      fullName:    userRow.fullName,
    })
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined)
    console.error('[auth-resolve] failed:', err)
    res.status(500).json({ error: 'internal' })
  } finally {
    client.release()
  }
})

// Suppress unused-import warning for buildKeycloakJwksUrl (exported for
// services that want to verify locally before calling this endpoint).
void buildKeycloakJwksUrl
void permissionCatalog
