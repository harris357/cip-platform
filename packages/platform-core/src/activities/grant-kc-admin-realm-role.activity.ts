import { z } from 'zod'
import { getKeycloakAdminToken, kcAdminFetch } from './keycloak-admin-token.helper.js'

// Slice 71: completes the KC half of bash section 7a — grants the realm
// 'hr' role to the admin user. Idempotent: POST role-mappings/realm is
// the canonical add; KC returns 204 if already present.
//
// Caller must have already created the KC user via the realm's normal
// onboarding flow (or an admin-create step). This activity only does the
// role grant; user creation is out of scope (slice 70's elevateAdminUser
// handles the DB side).

const InputSchema = z.object({
  tenantId:    z.string().uuid(),
  adminEmail:  z.string().email(),
  realmRole:   z.string().min(1).default('hr'),
})
const OutputSchema = z.object({
  granted: z.boolean(),
  reason:  z.string().optional(),
})
export type GrantKcAdminRealmRoleInput  = z.infer<typeof InputSchema>
export type GrantKcAdminRealmRoleOutput = z.infer<typeof OutputSchema>

interface KcUserRow { id: string; email?: string }
interface KcRoleRep { id: string; name: string; containerId?: string }

export async function grantKcAdminRealmRole(input: unknown): Promise<GrantKcAdminRealmRoleOutput> {
  const parsed = InputSchema.parse(input)
  const realm = parsed.tenantId
  const { token, keycloakBase } = await getKeycloakAdminToken()

  // Find user by email
  const userResp = await kcAdminFetch(
    keycloakBase, token, 'GET',
    `/admin/realms/${encodeURIComponent(realm)}/users?email=${encodeURIComponent(parsed.adminEmail)}&exact=true`,
  )
  if (!userResp.ok) {
    return OutputSchema.parse({ granted: false, reason: `user lookup HTTP ${userResp.status}` })
  }
  const users = (await userResp.json()) as KcUserRow[]
  if (users.length === 0 || !users[0]) {
    return OutputSchema.parse({ granted: false, reason: `no KC user with email ${parsed.adminEmail} (admin must sign in once first, OR a future activity will admin-create)` })
  }
  const userId = users[0].id

  // Find realm role
  const roleResp = await kcAdminFetch(
    keycloakBase, token, 'GET',
    `/admin/realms/${encodeURIComponent(realm)}/roles/${encodeURIComponent(parsed.realmRole)}`,
  )
  if (!roleResp.ok) {
    return OutputSchema.parse({ granted: false, reason: `realm role '${parsed.realmRole}' not found` })
  }
  const role = (await roleResp.json()) as KcRoleRep

  // Grant role mapping (idempotent — KC returns 204 if already mapped)
  const grantResp = await kcAdminFetch(
    keycloakBase, token, 'POST',
    `/admin/realms/${encodeURIComponent(realm)}/users/${userId}/role-mappings/realm`,
    [role],
  )
  if (!grantResp.ok && grantResp.status !== 204) {
    return OutputSchema.parse({ granted: false, reason: `grant HTTP ${grantResp.status}` })
  }
  return OutputSchema.parse({ granted: true })
}
