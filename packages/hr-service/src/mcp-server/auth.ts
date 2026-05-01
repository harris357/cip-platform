import { getPool } from '../db/index.js'
import { findEmployeeByKeycloakId } from '../db/queries/employees.js'
import { getPermissionsForEmployee } from '../db/queries/permissions.js'

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

export class PermissionDeniedError extends Error {
  readonly code = 'permission_denied'
  constructor(public readonly required: string) {
    super(`Permission denied: missing '${required}'`)
    this.name = 'PermissionDeniedError'
  }
}

/**
 * Slice 38 + 42C: defense-in-depth permission check used by HR MCP tool
 * handlers. Resolves the calling employee row by keycloak_id (= JWT sub)
 * within the caller's tenant, then chains through the role layer
 * (employee_role_assignments → role_groups → permission_groups) to flatten
 * + glob-expand the permission set. Throws PermissionDeniedError if the
 * required code is not in the set.
 *
 * Uses raw PoolClient + manual BEGIN / set_config so it composes with the
 * same RLS-GUC pattern used elsewhere in employee tools (audit.ts,
 * employee.assign-role.tool.ts).
 */
export async function assertPermission(
  authInfo: { token: string } | undefined,
  required: string,
): Promise<void> {
  const ctx = extractAuthContext(authInfo)
  const pool = getPool()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [ctx.tenantId])
    const employee = await findEmployeeByKeycloakId(client, ctx.tenantId, ctx.employeeId)
    if (!employee) {
      throw new PermissionDeniedError(required)
    }
    const perms = await getPermissionsForEmployee(client, employee.id)
    await client.query('COMMIT')
    if (!perms.includes(required)) {
      throw new PermissionDeniedError(required)
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw err
  } finally {
    client.release()
  }
}
