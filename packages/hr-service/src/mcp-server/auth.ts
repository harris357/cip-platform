export interface McpAuthContext {
  tenantId: string
  employeeId: string
  roles: string[]
}

export function extractAuthContext(authInfo: { token: string } | undefined): McpAuthContext {
  if (!authInfo?.token) throw new Error('Missing bearer token in MCP auth context')
  const parts = authInfo.token.split('.')
  if (parts.length !== 3) throw new Error('Invalid JWT format')
  const payloadJson = Buffer.from(parts[1]!, 'base64url').toString('utf-8')
  const payload = JSON.parse(payloadJson) as Record<string, unknown>
  const tenantId = payload['tenantId']
  const sub = payload['sub']
  const rolesRaw = payload['roles']
  if (typeof tenantId !== 'string' || !tenantId)
    throw new Error('JWT missing tenantId claim — check Keycloak Protocol Mapper')
  if (typeof sub !== 'string' || !sub)
    throw new Error('JWT missing sub claim')
  return {
    tenantId,
    employeeId: sub,
    roles: Array.isArray(rolesRaw) ? (rolesRaw as string[]) : [],
  }
}
