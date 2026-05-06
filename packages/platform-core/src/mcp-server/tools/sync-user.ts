import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { randomUUID } from 'node:crypto'
import { eq, and, sql } from 'drizzle-orm'
import { getDb } from '../../db/index.js'
import { users, userIdentityLinks } from '../../db/schema.js'
import { extractAuthContext } from '../auth.js'

// Slice 66: platform-core's first MCP tool. JWT-driven user upsert. Writes
// only to cip_platform.users + cip_platform.user_identity_links — does NOT
// touch cip_hr.employees. Bot calls this on every turn before any other
// MCP work; ensure_employee (hr-service) is the separate "is this user an
// employee?" check.

interface IdentityCandidate {
  provider: 'keycloak' | 'aad'
  subject:  string
}

async function setLocalTenant(client: { query: (sql: string, params: unknown[]) => Promise<unknown> }, tenantId: string): Promise<void> {
  await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantId])
}

export function registerSyncUser(server: McpServer): void {
  server.tool(
    'sync_user',
    'Internal — re-reads the caller\'s JWT and upserts their User + identity links. ' +
    'Takes NO arguments. Idempotent. Fails closed if JWT has no derivable identity link.',
    {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {
      requiredPermission: null,
      sideEffectLevel:    'write',
      whenToUse: ['Internal — bot first call per turn'],
      whenNotToUse: ['User-facing requests — args are ignored, this only mirrors JWT claims'],
      commonNextTools: [],
      outputSchema: {
        type: 'object',
        required: ['data'],
        properties: {
          data: {
            type: 'object',
            required: ['userId'],
            properties: {
              userId:  { type: 'string', format: 'uuid' },
              created: { type: 'boolean' },
            },
          },
        },
      },
    } as any,
    async (_args, context) => {
      const ctx = extractAuthContext(context.authInfo)

      const linkValues: IdentityCandidate[] = []
      if (ctx.keycloakSub) linkValues.push({ provider: 'keycloak', subject: ctx.keycloakSub })
      if (ctx.aadOid)      linkValues.push({ provider: 'aad',      subject: ctx.aadOid })
      if (linkValues.length === 0) {
        throw new Error('sync_user: JWT has no derivable identity link — refusing to create orphan user')
      }

      const db = getDb()
      const result = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${ctx.tenantId}, true)`)

        // 1. Look up by canonical link (KC sub never changes for a user)
        const linkRow = await tx
          .select({ userId: userIdentityLinks.userId })
          .from(userIdentityLinks)
          .where(and(
            eq(userIdentityLinks.tenantId, ctx.tenantId),
            eq(userIdentityLinks.provider, 'keycloak'),
            eq(userIdentityLinks.subject, ctx.keycloakSub),
          ))
          .limit(1)

        let userId: string
        let created = false

        if (linkRow.length > 0) {
          userId = linkRow[0]!.userId
          await tx
            .update(users)
            .set({
              email:     ctx.email,
              fullName:  ctx.fullName,
              givenName: ctx.givenName,
              surname:   ctx.surname,
              updatedAt: sql`NOW()` as unknown as Date,
            })
            .where(eq(users.id, userId))
        } else {
          userId = randomUUID()
          created = true
          await tx.insert(users).values({
            id:           userId,
            tenantId:     ctx.tenantId,
            email:        ctx.email,
            fullName:     ctx.fullName,
            givenName:    ctx.givenName,
            surname:      ctx.surname,
            identityType: 'aad_federated',
          })
        }

        // 2. Upsert identity links (one row per provider seen)
        for (const { provider, subject } of linkValues) {
          await tx
            .insert(userIdentityLinks)
            .values({ userId, tenantId: ctx.tenantId, provider, subject })
            .onConflictDoUpdate({
              target: [userIdentityLinks.userId, userIdentityLinks.provider],
              set: { subject, updatedAt: sql`NOW()` as unknown as Date },
            })
        }

        return { userId, created }
      })

      const response = {
        data: { userId: result.userId, created: result.created },
        message: result.created ? 'User provisioned.' : 'User refreshed.',
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(response) }] }
    },
  )
}

// Avoid unused import in some strict configs
void setLocalTenant
