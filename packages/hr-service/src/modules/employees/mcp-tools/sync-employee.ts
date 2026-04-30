import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { randomUUID } from 'crypto'
import { eq, and } from 'drizzle-orm'
import type { McpModuleResponse } from '@cip/shared'
import { getDb } from '../../../db/index.js'
import { withTenantRLS } from '../../../db/rls.js'
import { employees } from '../../../db/schema.js'

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

export function registerSyncEmployee(server: McpServer): void {
  server.tool(
    'sync_employee',
    'Upsert the calling user as an employee record from their JWT claims. Call before get_employee_permissions for first-time users.',
    {},
    async (_args, context) => {
      const { tenantId, keycloakId, email, fullName, givenName, surname, aadOid } =
        extractSyncClaims(context.authInfo?.token ?? '')

      const db = getDb()

      const employeeId = await withTenantRLS(db, tenantId, async (tx) => {
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
          return existing[0]!.id
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
        return id
      })

      const response: McpModuleResponse<{ employeeId: string }> = {
        data: { employeeId },
        message: 'Employee record synced.',
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(response) }] }
    },
  )
}
