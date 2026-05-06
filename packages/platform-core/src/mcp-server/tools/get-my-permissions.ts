import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { eq, and, sql } from 'drizzle-orm'
import { getDb, getPool } from '../../db/index.js'
import { userIdentityLinks } from '../../db/schema.js'
import { extractAuthContext } from '../auth.js'

// Slice 69: replaces hr-service's get_employee_permissions. Reads from
// cip_platform.* directly (single-schema after slice 68). Returns the
// caller's deduped permission codes (glob-expanded) and role codes.
// Bot's resolve-context.ts calls this every turn.

export function registerGetMyPermissions(server: McpServer): void {
  server.tool(
    'get_my_permissions',
    'Return the CALLING user\'s own roles and effective permissions. ' +
    'Use when the user asks "what are my roles", "what permissions do I have", "what can I do". ' +
    'Scope: caller only. ' +
    'Audience: every authenticated user (no gate; you can always see your own). ' +
    'Output: {roles[], permissions[]} (permissions are glob-expanded against permission_catalog).',
    {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {
      requiredPermission: null,
      sideEffectLevel: 'read',
      whenToUse: ['User asks "what are my roles" / "what permissions do I have" / "what can I do"'],
      whenNotToUse: ['User is asking about another user — admin tool', 'User wants the role catalog — different tool'],
      commonNextTools: [],
      outputSchema: {
        type: 'object',
        required: ['data', 'message'],
        properties: {
          data: {
            type: 'object',
            required: ['roles', 'permissions'],
            properties: {
              roles:       { type: 'array', items: { type: 'string' } },
              permissions: { type: 'array', items: { type: 'string' } },
            },
          },
          message: { type: 'string' },
        },
      },
    } as any,
    async (_args, context) => {
      const ctx = extractAuthContext(context.authInfo)
      const db = getDb()

      // Resolve userId via keycloak link (set by sync_user).
      const userIdResult = await db.transaction(async (tx) => {
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
        return linkRow[0]?.userId ?? null
      })

      if (!userIdResult) {
        const empty = {
          data: { permissions: [], roles: [] },
          message: 'Caller is not provisioned in this tenant.',
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify(empty) }] }
      }

      // Use raw pool for the chain query — easier with multiple statements.
      const pool = getPool()
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [ctx.tenantId])

        const permRes = await client.query<{ p: string }>(
          `SELECT DISTINCT jsonb_array_elements_text(pg.permissions) AS p
             FROM cip_platform.user_role_assignments ura
             JOIN cip_platform.role_groups rg       ON rg.role_id = ura.role_id
             JOIN cip_platform.permission_groups pg ON pg.id      = rg.group_id
            WHERE ura.user_id = $1`,
          [userIdResult],
        )
        const raw = permRes.rows.map(r => r.p)

        let permissions: string[]
        const globs    = raw.filter(p => p.endsWith('*'))
        const literals = raw.filter(p => !p.endsWith('*'))
        if (globs.length === 0) {
          permissions = Array.from(new Set(literals)).sort()
        } else {
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
        }

        const rolesRes = await client.query<{ code: string }>(
          `SELECT r.code
             FROM cip_platform.user_role_assignments ura
             JOIN cip_platform.roles r ON r.id = ura.role_id
            WHERE ura.user_id = $1
            ORDER BY r.code`,
          [userIdResult],
        )
        const roles = rolesRes.rows.map(r => r.code)
        await client.query('COMMIT')

        const rolesLine = roles.length > 0 ? roles.map(r => `\`${r}\``).join(', ') : '_(none)_'
        const permsList = permissions.length > 0 ? permissions.map(p => `\`${p}\``).join(', ') : '_(none)_'
        const message =
          `You have **${roles.length}** role(s): ${rolesLine}\n\n` +
          `**${permissions.length}** permission(s): ${permsList}`

        const response = {
          data: { permissions, roles },
          message,
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify(response) }] }
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw err
      } finally {
        client.release()
      }
    },
  )
}
