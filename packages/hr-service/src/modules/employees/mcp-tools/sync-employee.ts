import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { randomUUID } from 'crypto'
import { eq, and } from 'drizzle-orm'
import type { McpModuleResponse } from '@cip/shared'
import { getDb, getPool } from '../../../db/index.js'
import { withTenantRLS } from '../../../db/rls.js'
import { employees } from '../../../db/schema.js'
import { assignRoleToEmployee } from '../../../db/queries/roles.js'
import { getKcAdmin, kcAdminRequest } from '../../../services/keycloak-admin.js'

function extractSyncClaims(token: string): {
  tenantId: string
  keycloakId: string
  email: string
  fullName: string
  givenName: string | null
  surname: string | null
  aadOid: string | null
} {
  if (!token) throw new Error('Missing bearer token')
  const parts = token.split('.')
  if (parts.length !== 3) throw new Error('Invalid JWT format')
  const payload = JSON.parse(
    Buffer.from(parts[1]!, 'base64url').toString('utf-8'),
  ) as Record<string, unknown>

  const tenantId = payload['tenantId']
  const sub = payload['sub']
  const email = payload['email'] ?? payload['preferred_username']
  const fullName = payload['name'] ?? email

  if (typeof tenantId !== 'string' || !tenantId) throw new Error('JWT missing tenantId')
  if (typeof sub !== 'string' || !sub) throw new Error('JWT missing sub')
  if (typeof email !== 'string' || !email) throw new Error('JWT missing email claim')

  return {
    tenantId,
    keycloakId: sub,
    email,
    fullName: typeof fullName === 'string' ? fullName : email,
    givenName: typeof payload['given_name'] === 'string' ? payload['given_name'] : null,
    surname: typeof payload['family_name'] === 'string' ? payload['family_name'] : null,
    aadOid: typeof payload['oid'] === 'string' ? payload['oid'] : null,
  }
}

// Slice 42B → Slice 56D follow-up: auto-elevate the platform admin
// email on EVERY sync (was: first-sync only). Both halves are
// idempotent (CIP role assignment ON CONFLICT; KC realm role grant
// returns 204 if already present), so re-running is cheap.
//
// Why dropped the first-sync-only guard: if KC was unreachable on
// first sync (the slice 56D root cause — KEYCLOAK_URL pointed at a
// non-existent service), step 2 silently failed and there was no
// recovery path. The user's role would be permanently missing.
//
// Trade-off accepted: a manual revoke of the platform admin's roles
// will be undone on their next sync. PLATFORM_ADMIN_EMAIL is the
// single source of truth — to drop someone from admin, remove them
// from .envrc + re-run create-secrets, not by manual KC revoke.
async function maybeAutoElevateAdmin(
  tenantId: string,
  employeeId: string,
  keycloakId: string,
  email: string,
): Promise<void> {
  const adminEmail = process.env['PLATFORM_ADMIN_EMAIL']?.toLowerCase().trim()
  if (!adminEmail) return
  if (email.toLowerCase().trim() !== adminEmail) return

  // Step 1: CIP role assignment.
  const pool = getPool()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantId])
    await assignRoleToEmployee(client, tenantId, employeeId, 'hr-service-admin', null)
    await client.query('COMMIT')
    console.log(`[sync_employee] auto-elevated CIP admin role: email=${email} tenantId=${tenantId}`)
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined)
    console.warn(`[sync_employee] CIP role auto-elevate failed: ${err instanceof Error ? err.message : String(err)}`)
    return
  } finally {
    client.release()
  }

  // Step 2: KC realm role grant. Use the tenant's KC admin client.
  try {
    const admin = await getKcAdmin(tenantId)
    const roleResp = await kcAdminRequest(admin, 'GET', `/roles/hr`)
    if (!roleResp.ok) {
      console.warn(`[sync_employee] KC role 'hr' lookup failed: HTTP ${roleResp.status}`)
      return
    }
    const roleRep = await roleResp.json()
    const grantResp = await kcAdminRequest(
      admin, 'POST', `/users/${keycloakId}/role-mappings/realm`, [roleRep],
    )
    if (grantResp.ok || grantResp.status === 204) {
      console.log(`[sync_employee] auto-elevated KC realm role hr: email=${email} tenantId=${tenantId}`)
    } else {
      console.warn(`[sync_employee] KC realm role grant failed: HTTP ${grantResp.status}`)
    }
  } catch (err) {
    console.warn(`[sync_employee] KC realm role auto-elevate failed: ${err instanceof Error ? err.message : String(err)}`)
    // Non-fatal — the next sync_employee will retry idempotently.
  }
}

export function registerSyncEmployee(server: McpServer): void {
  server.tool(
    'sync_employee',
    'Internal identity sync only — re-reads the caller\'s JWT (Keycloak/AAD) and upserts their employee row. ' +
    'Takes NO arguments and IGNORES any args supplied by an LLM. ' +
    'CANNOT be used to change a user\'s name, email, or any profile field — those come from corporate identity (AAD/Keycloak) and this tool only mirrors them. ' +
    'Scope: the caller only. ' +
    'Audience: every authenticated user (no gate). ' +
    'Output: {employeeId}. Idempotent — re-syncs update mutable fields (email, fullName) from JWT but never re-trigger first-sync side effects (admin auto-elevation). ' +
    'Used internally by the bot on every turn before get_employee_permissions. ' +
    'No sibling overlap.',
    {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {
      requiredPermission: null,
      sideEffectLevel: 'write',
      whenToUse: [
        'Internal — called by the bot on every turn before get_employee_permissions',
      ],
      whenNotToUse: [
        'Never call this in response to a user request',
        'User asked to change their name, email, or any profile field — sync_employee CANNOT do that. The user\'s name and email come from their AAD/Keycloak identity. Decline and explain the source of truth is corporate identity.',
        'User asked to update their record with a specific value — args are IGNORED; this tool only mirrors JWT claims',
      ],
      commonNextTools: ['get_employee_permissions'],
      outputSchema: {
        type: 'object',
        required: ['data'],
        properties: {
          data: {
            type: 'object',
            required: ['employeeId'],
            properties: { employeeId: { type: 'string', format: 'uuid' } },
          },
          message: { type: 'string' },
        },
      },
    } as any,
    async (_args, context) => {
      const { tenantId, keycloakId, email, fullName, givenName, surname, aadOid } =
        extractSyncClaims(context.authInfo?.token ?? '')

      const db = getDb()

      // isNewlyCreated tells us whether this turn's INSERT actually fired
      // (vs hitting the existing-row branch). Auto-elevation only fires on
      // first sync — re-syncs don't re-elevate (so a manual revoke isn't
      // undone by the user signing in again).
      const { employeeId, isNewlyCreated } = await withTenantRLS(db, tenantId, async (tx) => {
        const existing = await tx
          .select({ id: employees.id })
          .from(employees)
          .where(and(eq(employees.tenantId, tenantId), eq(employees.keycloakId, keycloakId)))
          .limit(1)

        if (existing.length > 0) {
          await tx
            .update(employees)
            .set({ email, fullName, givenName, surname, aadOid, updatedAt: new Date() })
            .where(and(eq(employees.tenantId, tenantId), eq(employees.keycloakId, keycloakId)))
          return { employeeId: existing[0]!.id, isNewlyCreated: false }
        }

        const id = randomUUID()
        await tx.insert(employees).values({
          id,
          tenantId,
          email,
          fullName,
          givenName,
          surname,
          aadOid,
          keycloakId,
          identityType: 'aad_federated',
          employmentType: 'employee',
        })
        return { employeeId: id, isNewlyCreated: true }
      })

      // Slice 56D follow-up: fire admin auto-elevation on EVERY sync.
      // Both steps inside are idempotent. The prior first-sync-only
      // guard left users permanently un-elevated when first sync's KC
      // call failed (root cause: misconfigured KEYCLOAK_URL service
      // name, fixed in this slice). isNewlyCreated is no longer used
      // for routing but kept above for future telemetry.
      void isNewlyCreated;
      await maybeAutoElevateAdmin(tenantId, employeeId, keycloakId, email)

      const response: McpModuleResponse<{ employeeId: string }> = {
        data: { employeeId },
        message: 'Employee record synced.',
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(response) }] }
    },
  )
}
