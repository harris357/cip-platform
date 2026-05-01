// Slice 43: centralized map of tool name → required permission for the
// bot's discoverTools filter. Mirrors the in-handler assertPermission /
// roles-includes('hr') checks in hr-service tool registrations.
//
// Why a map (not annotations on the MCP tool registration): the MCP SDK
// requires positional arg shuffling to attach `annotations`, and we have
// ~30 tools to update. The tool-discovery filter is the only place this
// is consumed, so a single map here is the simpler interface. Server-side
// permission gates (assertPermission inside each handler) remain the
// authoritative check; this map is the *UX* filter that decides which
// tools the LLM ever sees.
//
// Two sentinel values:
//   null      → no permission required; visible to every authenticated user
//   'role:hr' → requires the `hr` Keycloak realm role (HR-only tools that
//               check ctx.roles.includes('hr') server-side, NOT a CIP
//               permission code)
//
// Anything else is a CIP permission code (module.action format) checked
// against ctx.permissions[code] === true.
//
// If a tool is registered without an entry here, the filter defaults to
// VISIBLE — matches today's behaviour (no annotation → not filtered).
// The server-side assertPermission then 401s on invoke. Known degraded
// mode, not a crash.

export type PermissionGate = string | 'role:hr' | null;

export const TOOL_PERMISSIONS: Record<string, PermissionGate> = {
  // ── Self-query (no gate — caller-only data) ──
  sync_employee:              null,
  get_employee_permissions:   null,
  permission_catalog_list:    null,
  get_tenant_channel_config:  null,

  // ── Caller's own cert data (cert.view_own, baseline `employee` role) ──
  get_my_certifications:      'cert.view_own',
  get_submission_status:      'cert.view_own',

  // ── Compliance / HR cert overview ──
  get_expiring_certifications: 'cert.list_all',

  // ── Cert actions ──
  process_document:           'cert.submit',     // baseline `employee` role
  resolve_hitl:               'cert.approve',    // HR / approver

  // ── Compliance (HR view of staff certs) ──
  get_compliance_summary:     'compliance.view',
  get_staff_certifications:   'cert.list_all',

  // ── Employee admin (HR realm role only) ──
  employee_create:            'role:hr',
  employee_list:              'role:hr',
  employee_find:              'role:hr',
  employee_assign_role:       'role:hr',
  employee_revoke_role:       'role:hr',
  employee_migrate_identity:  'role:hr',
  employee_disable:           'role:hr',
  list_staff:                 'employee.list',

  // ── Employee admin (HR + specific permission) ──
  employee_grant_permission:  'employee.grant_permission',
  employee_revoke_permission: 'employee.revoke_permission',

  // ── Specific employee lookup (employee.find permission) ──
  employee_get:               'employee.find',

  // ── Admin read tools (employee.list permission) ──
  role_list:                  'employee.list',
  role_get:                   'employee.list',
  role_members:               'employee.list',
  group_list:                 'employee.list',
  group_get:                  'employee.list',
  permission_holders:         'employee.list',
  audit_log_list:             'employee.list',
};

/**
 * Returns true if the caller (with their permissions + roles) is allowed
 * to see/invoke this tool. False = filter it out of the discovered set.
 * Tools not in the map default to allowed (server-side check is the gate).
 */
export function isToolPermitted(
  toolName: string,
  permissions: Record<string, boolean>,
  roles: string[],
): boolean {
  const gate = TOOL_PERMISSIONS[toolName];
  if (gate === undefined) return true;        // unknown tool → defer to server
  if (gate === null) return true;             // no gate → permitted
  if (gate === 'role:hr') return roles.includes('hr');
  return permissions[gate] === true;
}
