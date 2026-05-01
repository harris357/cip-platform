// Slice 45: deterministic 1-line summaries of tool results.
//
// Goal: ~80-char human-readable line that the planner can carry forward
// across a multi-step turn without re-injecting raw tool output. NO LLM
// CALL — pure string formatting.
//
// Per-tool hand-written formatters where the shape is known. Falls back
// to a generic "<toolName> returned <N> keys" for unknown tools.

interface McpEnvelope {
  data?:    unknown;
  message?: string;
  card?:    unknown;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function distillFact(toolName: string, result: unknown): string {
  // MCP tools return { content: [{ type: 'text', text: <JSON> }] }; the
  // executor unwraps to the inner envelope before calling us. If we got
  // the raw MCP shape, parse first.
  const env: McpEnvelope = isMcpResult(result)
    ? parseMcpResult(result)
    : (isObject(result) ? (result as McpEnvelope) : { data: result });

  // Refusals first.
  if (isObject(env.data) && env.data['refused']) {
    return `${toolName} refused: ${env.data['refused']}`;
  }

  switch (toolName) {
    case 'get_employee_permissions': {
      const d = isObject(env.data) ? env.data : {};
      const roles = (d['roles'] as string[] | undefined) ?? [];
      const perms = (d['permissions'] as string[] | undefined) ?? [];
      return `${toolName}: ${roles.length} role(s) [${roles.slice(0, 3).join(', ')}${roles.length > 3 ? ', …' : ''}], ${perms.length} permission(s)`;
    }
    case 'role_list': {
      const d = isObject(env.data) ? env.data : {};
      const roles = (d['roles'] as Array<{ code?: string }> | undefined) ?? [];
      return `${toolName}: ${roles.length} role(s) — ${roles.slice(0, 4).map(r => r.code).join(', ')}${roles.length > 4 ? ', …' : ''}`;
    }
    case 'role_get': {
      const d = isObject(env.data) ? env.data : {};
      const role = isObject(d['role']) ? d['role'] : {};
      const groups = (d['groups'] as unknown[] | undefined) ?? [];
      const perms = (d['permissions'] as string[] | undefined) ?? [];
      return `${toolName}: role=${role['code']}, ${groups.length} group(s), ${perms.length} permission(s)`;
    }
    case 'role_members':
    case 'permission_holders': {
      const d = isObject(env.data) ? env.data : {};
      const total = d['total'] as number | undefined;
      return `${toolName}: ${total ?? '?'} member(s)`;
    }
    case 'group_list': {
      const d = isObject(env.data) ? env.data : {};
      const groups = (d['groups'] as Array<{ code?: string }> | undefined) ?? [];
      return `${toolName}: ${groups.length} group(s) — ${groups.slice(0, 4).map(g => g.code).join(', ')}${groups.length > 4 ? ', …' : ''}`;
    }
    case 'group_get': {
      const d = isObject(env.data) ? env.data : {};
      const perms = (d['permissions'] as string[] | undefined) ?? [];
      const usedBy = (d['usedByRoles'] as unknown[] | undefined) ?? [];
      return `${toolName}: ${perms.length} permission(s), used by ${usedBy.length} role(s)`;
    }
    case 'employee_list': {
      const d = isObject(env.data) ? env.data : {};
      const count = d['count'] as number | undefined;
      return `${toolName}: ${count ?? '?'} employee(s)`;
    }
    case 'employee_find': {
      const d = isObject(env.data) ? env.data : {};
      const emp = isObject(d['employee']) ? d['employee'] : null;
      if (!emp) return `${toolName}: not_found`;
      return `${toolName}: ${emp['fullName']} <${emp['email']}> id=${emp['id']}`;
    }
    case 'employee_get': {
      const d = isObject(env.data) ? env.data : {};
      const emp = isObject(d['employee']) ? d['employee'] : {};
      const roles = (d['roles'] as string[] | undefined) ?? [];
      return `${toolName}: ${emp['fullName']} (${roles.length} role(s))`;
    }
    case 'employee_create':
      return `${toolName}: employee created`;
    case 'employee_assign_role':
    case 'employee_revoke_role':
    case 'employee_grant_permission':
    case 'employee_revoke_permission': {
      const d = isObject(env.data) ? env.data : {};
      return `${toolName}: ${d['role']} on ${d['employeeId']}`;
    }
    case 'employee_disable':
      return `${toolName}: disabled`;
    case 'get_my_certifications': {
      const certs = Array.isArray(env.data) ? env.data : [];
      return `${toolName}: ${certs.length} cert(s)`;
    }
    case 'get_compliance_summary': {
      const d = isObject(env.data) ? env.data : {};
      return `${toolName}: ${d['valid'] ?? '?'} valid, ${d['expiring'] ?? '?'} expiring, ${d['expired'] ?? '?'} expired`;
    }
    case 'get_expiring_certifications': {
      const groups = Array.isArray(env.data) ? env.data : [];
      return `${toolName}: ${groups.length} employee(s) with expiring certs`;
    }
    case 'audit_log_list': {
      const d = isObject(env.data) ? env.data : {};
      return `${toolName}: ${d['total'] ?? '?'} event(s)`;
    }
    case 'permission_catalog_list': {
      const d = isObject(env.data) ? env.data : {};
      return `${toolName}: ${d['total'] ?? '?'} permission code(s)`;
    }
    case 'process_document': {
      const d = isObject(env.data) ? env.data : {};
      return `${toolName}: submissionId=${d['submissionId']}`;
    }
  }

  // Generic fallback.
  if (isObject(env.data)) {
    const keys = Object.keys(env.data);
    return `${toolName} returned ${keys.length} field(s): ${keys.slice(0, 5).join(', ')}`;
  }
  if (Array.isArray(env.data)) {
    return `${toolName} returned ${env.data.length} item(s)`;
  }
  return `${toolName} returned ${typeof env.data}`;
}

function isMcpResult(v: unknown): v is { content: Array<{ type: string; text?: string }> } {
  return isObject(v) && Array.isArray((v as Record<string, unknown>)['content']);
}

function parseMcpResult(v: { content: Array<{ type: string; text?: string }> }): McpEnvelope {
  const text = v.content.find(c => c.type === 'text')?.text;
  if (!text) return {};
  try {
    return JSON.parse(text) as McpEnvelope;
  } catch {
    return {};
  }
}
