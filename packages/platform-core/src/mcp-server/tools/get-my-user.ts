import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { eq, and, sql } from 'drizzle-orm'
import { getDb } from '../../db/index.js'
import { users, userIdentityLinks } from '../../db/schema.js'
import { extractAuthContext } from '../auth.js'

// Slice 69: caller's User record. Identity-only — no HR fields. Lookup
// via the canonical KC link; fails closed if sync_user hasn't run yet.

export function registerGetMyUser(server: McpServer): void {
  server.tool(
    'get_my_user',
    'Return the calling user\'s identity record from cip_platform.users. ' +
    'Scope: caller only. Takes NO arguments. ' +
    'Output: {user: {id, tenantId, email, fullName, givenName, surname, identityType}}. ' +
    'Returns user_not_found if sync_user has not been called for this user yet.',
    {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {
      requiredPermission: null,
      sideEffectLevel: 'read',
      whenToUse: ['Internal — fetch caller identity for downstream tools / display'],
      whenNotToUse: ['User-facing detail about another user — that\'s an admin tool, not this'],
      commonNextTools: ['get_my_permissions'],
      outputSchema: {
        type: 'object',
        required: ['data'],
        properties: {
          data: {
            type: ['object', 'null'],
            properties: {
              user: { type: 'object' },
            },
          },
          error:   { type: 'string' },
          message: { type: 'string' },
        },
      },
    } as any,
    async (_args, context) => {
      const ctx = extractAuthContext(context.authInfo)
      const db = getDb()

      const result = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${ctx.tenantId}, true)`)
        const linkRow = await tx
          .select({ userId: userIdentityLinks.userId })
          .from(userIdentityLinks)
          .where(and(
            eq(userIdentityLinks.tenantId, ctx.tenantId),
            eq(userIdentityLinks.provider, 'keycloak'),
            eq(userIdentityLinks.subject,  ctx.keycloakSub),
          ))
          .limit(1)
        if (linkRow.length === 0) return null
        const userRow = await tx.select().from(users).where(eq(users.id, linkRow[0]!.userId)).limit(1)
        return userRow[0] ?? null
      })

      if (!result) {
        const response = { data: null, error: 'user_not_found', message: 'sync_user must run first' }
        return { content: [{ type: 'text' as const, text: JSON.stringify(response) }] }
      }
      const response = {
        data: { user: result },
        message: `User: ${result.fullName} <${result.email}>`,
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(response) }] }
    },
  )
}
