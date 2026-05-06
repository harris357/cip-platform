import { z } from 'zod'
import { getKeycloakAdminToken, kcAdminFetch } from './keycloak-admin-token.helper.js'

// Slice 71: replaces bash section 6. Conditional — runs only when the
// tenant supplied an aadTenantId (Entra GUID). Sets up:
//   1. KC IDP instance (alias='aad') with AAD's authorization + token URLs
//   2. OIDC mapper that copies the 'oid' claim into a user attribute
//
// Bash also configures BOT_APP_ID + BOT_APP_PASSWORD as the IDP's own
// client credentials (the platform's bot-app registration in AAD). We
// pull those from env; if unset, log + skip (operator can backfill).

const InputSchema = z.object({
  tenantId:    z.string().uuid(),
  aadTenantId: z.string().min(1),  // Entra tenant GUID
  alias:       z.string().min(1).default('aad'),
})
const OutputSchema = z.object({
  configured: z.boolean(),
  reason:     z.string().optional(),
})
export type CreateAadIdpFederationInput  = z.infer<typeof InputSchema>
export type CreateAadIdpFederationOutput = z.infer<typeof OutputSchema>

interface IdpInstance { alias: string }

export async function createAadIdpFederation(input: unknown): Promise<CreateAadIdpFederationOutput> {
  const parsed = InputSchema.parse(input)
  const realm = parsed.tenantId

  const botAppId       = process.env['BOT_APP_ID']       ?? ''
  const botAppPassword = process.env['BOT_APP_PASSWORD'] ?? ''
  if (!botAppId || !botAppPassword) {
    return OutputSchema.parse({
      configured: false,
      reason:     'BOT_APP_ID/BOT_APP_PASSWORD not set; AAD federation skipped (operator can re-run)',
    })
  }

  const { token, keycloakBase } = await getKeycloakAdminToken()

  const tokenUrl  = `https://login.microsoftonline.com/${parsed.aadTenantId}/oauth2/v2.0/token`
  const authUrl   = `https://login.microsoftonline.com/${parsed.aadTenantId}/oauth2/v2.0/authorize`
  const issuer    = `https://login.microsoftonline.com/${parsed.aadTenantId}/v2.0`

  // 1. Idempotent IDP instance create. GET-by-alias first.
  const existResp = await kcAdminFetch(
    keycloakBase, token, 'GET',
    `/admin/realms/${encodeURIComponent(realm)}/identity-provider/instances/${encodeURIComponent(parsed.alias)}`,
  )
  let exists = existResp.ok
  if (!exists) {
    const createResp = await kcAdminFetch(keycloakBase, token, 'POST',
      `/admin/realms/${encodeURIComponent(realm)}/identity-provider/instances`,
      {
        alias:          parsed.alias,
        displayName:    'Microsoft Entra ID',
        providerId:     'oidc',
        enabled:        true,
        trustEmail:     true,
        storeToken:     false,
        addReadTokenRoleOnCreate: false,
        config: {
          tokenUrl,
          authorizationUrl:    authUrl,
          issuer,
          clientId:            botAppId,
          clientSecret:        botAppPassword,
          defaultScope:        'openid profile email',
          syncMode:            'IMPORT',
          backchannelSupported: 'false',
          useJwksUrl:          'true',
          jwksUrl:             `https://login.microsoftonline.com/${parsed.aadTenantId}/discovery/v2.0/keys`,
          validateSignature:   'true',
        },
      },
    )
    if (!createResp.ok && createResp.status !== 409) {
      const t = await createResp.text().catch(() => '')
      return OutputSchema.parse({ configured: false, reason: `IDP create HTTP ${createResp.status} ${t}` })
    }
    exists = true
  }

  // 2. Idempotent OID mapper.
  const mappersResp = await kcAdminFetch(
    keycloakBase, token, 'GET',
    `/admin/realms/${encodeURIComponent(realm)}/identity-provider/instances/${encodeURIComponent(parsed.alias)}/mappers`,
  )
  if (mappersResp.ok) {
    const mappers = (await mappersResp.json()) as Array<{ name: string }>
    if (!mappers.some(m => m.name === 'aad-oid-mapper')) {
      const createMapper = await kcAdminFetch(keycloakBase, token, 'POST',
        `/admin/realms/${encodeURIComponent(realm)}/identity-provider/instances/${encodeURIComponent(parsed.alias)}/mappers`,
        {
          name:                  'aad-oid-mapper',
          identityProviderAlias: parsed.alias,
          identityProviderMapper: 'oidc-user-attribute-idp-mapper',
          config: {
            'syncMode':       'INHERIT',
            'claim':          'oid',
            'user.attribute': 'oid',
          },
        },
      )
      if (!createMapper.ok && createMapper.status !== 409) {
        const t = await createMapper.text().catch(() => '')
        return OutputSchema.parse({ configured: false, reason: `mapper create HTTP ${createMapper.status} ${t}` })
      }
    }
  }

  // Suppress unused var warnings
  void exists
  void ({} as IdpInstance)

  return OutputSchema.parse({ configured: true })
}
