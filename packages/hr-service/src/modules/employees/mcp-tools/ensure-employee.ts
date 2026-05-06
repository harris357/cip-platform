import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { eq, and, sql } from 'drizzle-orm'
import type { McpModuleResponse } from '@cip/shared'
import { getDb, getPool } from '../../../db/index.js'
import { withTenantRLS } from '../../../db/rls.js'
import { employees, userIdentityLinks } from '../../../db/schema.js'
import { getTenantAutoOnboard } from '../../../db/queries/tenant-settings.js'
import { extractAuthContext } from '../../../mcp-server/auth.js'
import { assignRoleToEmployee } from '../../../db/queries/roles.js'
import { getKcAdmin, kcAdminRequest } from '../../../services/keycloak-admin.js'

// Slice 66: replaces sync_employee. The bot calls platform-core sync_user
// first (creates User + identity links). When the bot needs HR context for
// the user, it calls this tool: it confirms the Employee exists, or — when
// the tenant has auto_onboard_employees=true — creates one.

interface EnsureClaims {
  tenantId:    string
  keycloakSub: string
  email:       string
  fullName:    string
}

function parseClaims(token: string | undefined): EnsureClaims {
  if (!token) throw new Error('Missing bearer token')
  const parts = token.split('.')
  if (parts.length !== 3) throw new Error('Invalid JWT format')
  const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf-8')) as Record<string, unknown>
  const tenantId    = payload['tenantId']
  const sub         = payload['sub']
  const email       = (payload['email'] ?? payload['preferred_username'])
  const fullName    = (payload['name'] ?? email)
  if (typeof tenantId !== 'string' || !tenantId)  throw new Error('JWT missing tenantId')
  if (typeof sub      !== 'string' || !sub)       throw new Error('JWT missing sub')
  if (typeof email    !== 'string' || !email)     throw new Error('JWT missing email/preferred_username')
  return {
    tenantId,
    keycloakSub: sub,
    email,
    fullName: typeof fullName === 'string' ? fullName : email,
  }
}

async function maybeAutoElevateAdmin(
  tenantId: string,
  employeeId: string,
  keycloakId: string,
  email: string,
): Promise<void> {
  const adminEmail = process.env['PLATFORM_ADMIN_EMAIL']?.toLowerCase().trim()
  if (!adminEmail) return
  if (email.toLowerCase().trim() !== adminEmail) return

  const pool = getPool()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantId])
    await assignRoleToEmployee(client, tenantId, employeeId, 'hr-service-admin', null)
    await client.query('COMMIT')
    console.log(`[ensure_employee] auto-elevated CIP admin role: email=${email} tenantId=${tenantId}`)
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined)
    console.warn(`[ensure_employee] CIP role auto-elevate failed: ${err instanceof Error ? err.message : String(err)}`)
    return
  } finally {
    client.release()
  }

  try {
    const admin = await getKcAdmin(tenantId)
    const roleResp = await kcAdminRequest(admin, 'GET', `/roles/hr`)
    if (!roleResp.ok) {
      console.warn(`[ensure_employee] KC role 'hr' lookup failed: HTTP ${roleResp.status}`)
      return
    }
    const roleRep = await roleResp.json()
    const grantResp = await kcAdminRequest(admin, 'POST', `/users/${keycloakId}/role-mappings/realm`, [roleRep])
    if (!grantResp.ok && grantResp.status !== 204) {
      console.warn(`[ensure_employee] KC realm role grant failed: HTTP ${grantResp.status}`)
    }
  } catch (err) {
    console.warn(`[ensure_employee] KC realm role auto-elevate failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export function registerEnsureEmployee(server: McpServer): void {
  server.tool(
    'ensure_employee',
    'Internal — confirms the caller has an Employee row in this tenant; auto-creates if tenant.auto_onboard_employees=true. ' +
    'Takes NO arguments. Returns {employeeId, source, created}. ' +
    'Returns user_not_found if sync_user has not been called yet for this user. ' +
    'Returns not_provisioned_in_hr if the tenant disables self-onboarding and no Employee exists.',
    {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {
      requiredPermission: null,
      sideEffectLevel: 'write',
      whenToUse: ['Internal — bot calls before invoking any HR tool'],
      whenNotToUse: ['User-facing requests — args ignored'],
      commonNextTools: ['get_employee_permissions'],
      outputSchema: {
        type: 'object',
        required: ['data'],
        properties: {
          data: {
            type: 'object',
            properties: {
              employeeId: { type: 'string', format: 'uuid' },
              source:     { type: 'string' },
              created:    { type: 'boolean' },
            },
          },
          error:   { type: 'string' },
          message: { type: 'string' },
        },
      },
    } as any,
    async (_args, context) => {
      const claims = parseClaims(context.authInfo?.token ?? '')
      const db = getDb()

      const result = await withTenantRLS(db, claims.tenantId, async (tx) => {
        // 1. Find user by keycloak link (set by platform-core's sync_user).
        const linkRow = await tx
          .select({ userId: userIdentityLinks.userId })
          .from(userIdentityLinks)
          .where(and(
            eq(userIdentityLinks.tenantId, claims.tenantId),
            eq(userIdentityLinks.provider, 'keycloak'),
            eq(userIdentityLinks.subject, claims.keycloakSub),
          ))
          .limit(1)

        if (linkRow.length === 0) {
          return { kind: 'user_not_found' as const }
        }
        const userId = linkRow[0]!.userId

        // 2. Look up existing employee.
        const existing = await tx
          .select({ id: employees.id, source: employees.onboardingSource })
          .from(employees)
          .where(eq(employees.userId, userId))
          .limit(1)
        if (existing.length > 0) {
          return {
            kind:        'exists' as const,
            employeeId:  existing[0]!.id,
            source:      existing[0]!.source,
            userId,
          }
        }

        // 3. Decide auto-onboard vs refuse.
        const pool = getPool()
        const client = await pool.connect()
        let autoOnboard: boolean
        try {
          autoOnboard = await getTenantAutoOnboard(client, claims.tenantId)
        } finally {
          client.release()
        }

        if (!autoOnboard) {
          return { kind: 'not_provisioned_in_hr' as const }
        }

        // 4. Auto-onboard.
        await tx.insert(employees).values({
          id:               userId,
          tenantId:         claims.tenantId,
          userId,
          employmentType:   'employee',
          onboardingSource: 'self',
        })
        await tx
          .update(employees)
          .set({ updatedAt: sql`NOW()` })
          .where(eq(employees.id, userId))

        return { kind: 'created' as const, employeeId: userId, source: 'self', userId }
      })

      if (result.kind === 'user_not_found') {
        // 'error' is a non-standard envelope field; resolve-context inspects it.
        const response = {
          data: null,
          error: 'user_not_found',
          message: 'sync_user must run first',
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify(response) }] }
      }
      if (result.kind === 'not_provisioned_in_hr') {
        const response = {
          data: null,
          error: 'not_provisioned_in_hr',
          message: 'tenant disables self-onboarding; admin must run employee.create',
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify(response) }] }
      }

      // Auto-elevate runs for both 'exists' (idempotent on every sync) and 'created'.
      try {
        const ctx = extractAuthContext(context.authInfo)
        await maybeAutoElevateAdmin(ctx.tenantId, result.employeeId, ctx.employeeId, claims.email)
      } catch (err) {
        console.warn('[ensure_employee] auto-elevate skipped:', err)
      }

      const response: McpModuleResponse<{ employeeId: string; source: string; created: boolean }> = {
        data: {
          employeeId: result.employeeId,
          source:     result.source,
          created:    result.kind === 'created',
        },
        message: result.kind === 'created' ? 'Employee provisioned (self-onboarded).' : 'Employee already exists.',
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(response) }] }
    },
  )
}
