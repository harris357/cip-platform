import { z } from 'zod'
import { getKeycloakAdminToken, kcAdminFetch } from './keycloak-admin-token.helper.js'

// Slice 71: replaces bash section 5. Creates the teams-bot + hr-service
// confidential clients in the new realm. Captures their secrets so
// downstream activities (createK8sSecret, etc.) can use them. Idempotent —
// returns existing client's secret if already present.

const InputSchema = z.object({
  tenantId: z.string().uuid(),
})
const OutputSchema = z.object({
  realm:           z.string(),
  teamsBotSecret:  z.string().min(1),
  hrServiceSecret: z.string().min(1),
})
export type CreateKeycloakClientsInput  = z.infer<typeof InputSchema>
export type CreateKeycloakClientsOutput = z.infer<typeof OutputSchema>

const CLIENT_DEFS: Array<{ clientId: string; description: string }> = [
  { clientId: 'teams-bot',  description: 'Microsoft Teams bot — JWT AG exchange' },
  { clientId: 'hr-service', description: 'HR service — service account for KC admin API and MCP' },
]

interface KcClientRow { id: string; clientId: string }

async function ensureClient(
  base: string,
  token: string,
  realm: string,
  spec: { clientId: string; description: string },
): Promise<{ uuid: string; secret: string }> {
  // GET existing
  const existResp = await kcAdminFetch(
    base, token, 'GET',
    `/admin/realms/${encodeURIComponent(realm)}/clients?clientId=${encodeURIComponent(spec.clientId)}`,
  )
  if (!existResp.ok) {
    throw new Error(`createKeycloakClients: GET clients HTTP ${existResp.status}`)
  }
  const existing = (await existResp.json()) as KcClientRow[]
  let uuid: string
  if (existing.length > 0 && existing[0]) {
    uuid = existing[0].id
  } else {
    const createResp = await kcAdminFetch(base, token, 'POST', `/admin/realms/${encodeURIComponent(realm)}/clients`, {
      clientId:                spec.clientId,
      description:             spec.description,
      enabled:                 true,
      clientAuthenticatorType: 'client-secret',
      serviceAccountsEnabled:  true,
      publicClient:            false,
      protocol:                'openid-connect',
      standardFlowEnabled:     false,
      directAccessGrantsEnabled: false,
    })
    if (!createResp.ok && createResp.status !== 409) {
      throw new Error(`createKeycloakClients: create ${spec.clientId} HTTP ${createResp.status}`)
    }
    // Re-fetch to get the UUID
    const after = await kcAdminFetch(
      base, token, 'GET',
      `/admin/realms/${encodeURIComponent(realm)}/clients?clientId=${encodeURIComponent(spec.clientId)}`,
    )
    const afterJson = (await after.json()) as KcClientRow[]
    if (!afterJson[0]) throw new Error(`createKeycloakClients: client ${spec.clientId} missing post-create`)
    uuid = afterJson[0].id
  }
  // GET secret
  const secResp = await kcAdminFetch(base, token, 'GET',
    `/admin/realms/${encodeURIComponent(realm)}/clients/${uuid}/client-secret`)
  if (!secResp.ok) throw new Error(`createKeycloakClients: get-secret ${spec.clientId} HTTP ${secResp.status}`)
  const sec = (await secResp.json()) as { value?: string }
  if (!sec.value) throw new Error(`createKeycloakClients: ${spec.clientId} secret missing`)
  return { uuid, secret: sec.value }
}

export async function createKeycloakClients(input: unknown): Promise<CreateKeycloakClientsOutput> {
  const parsed = InputSchema.parse(input)
  const realm = parsed.tenantId
  const { token, keycloakBase } = await getKeycloakAdminToken()

  const [teamsBot, hrService] = await Promise.all([
    ensureClient(keycloakBase, token, realm, CLIENT_DEFS[0]!),
    ensureClient(keycloakBase, token, realm, CLIENT_DEFS[1]!),
  ])

  return OutputSchema.parse({
    realm,
    teamsBotSecret:  teamsBot.secret,
    hrServiceSecret: hrService.secret,
  })
}
