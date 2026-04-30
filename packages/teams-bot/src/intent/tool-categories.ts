// Slice 39B: tool category enum + per-category MCP tool subsets used
// to filter the catalog before Stage 2 picks a tool.

import type { Tool as McpTool } from '@modelcontextprotocol/sdk/types.js';

export const CATEGORIES = [
  'chitchat',     // "hi", "thanks" — inline reply, no tools
  'meta',         // "what can you do?" — inline reply
  'cert_query',   // "show my certs", "when does X expire"
  'cert_action',  // "upload this cert"
  'hr_admin',     // "create employee X", "disable Y"
  'reasoning',    // multi-step / fall-through
] as const;

export type Category = (typeof CATEGORIES)[number];

/**
 * Slice 39B: which Slice 39A `purpose` to resolve for each category's
 * Stage-2 LLM call. Categories with null skip Stage 2 entirely (the
 * classifier's inline_reply path handles the user response).
 */
export const PURPOSE_FOR_CATEGORY: Record<Category, string | null> = {
  chitchat:    null,                 // inline_reply only
  meta:        null,                 // inline_reply only
  cert_query:  'route_simple',
  cert_action: 'route_simple',
  hr_admin:    'route_careful',
  reasoning:   'route_reasoning',
};

/**
 * Slice 39B: per-category tool catalog filter. Names are MCP tool names
 * (matching server.tool('<name>') registrations in hr-service).
 *
 * `null` = no Stage 2 (chitchat/meta) OR all tools (reasoning — multi-step
 * intents may span domains, no useful catalog filter).
 */
const TOOLS_FOR_CATEGORY: Record<Category, string[] | null> = {
  chitchat: null,
  meta:     null,

  cert_query: [
    'get_my_certifications',
    'get_submission_status',
    'get_expiring_certifications',
    'get_staff_certifications',
    'get_compliance_summary',
  ],

  cert_action: [
    'process_document',
    'resolve_hitl',
  ],

  hr_admin: [
    'employee_create',
    'employee_list',
    'employee_find',
    'employee_assign_role',
    'employee_revoke_role',
    'employee_migrate_identity',
    'employee_disable',
    'employee_grant_permission',
    'employee_revoke_permission',
    'list_staff',
  ],

  reasoning: null, // null here means "use all permitted tools, not a subset"
};

export function filterToolsByCategory(
  tools: McpTool[],
  category: Category,
): McpTool[] {
  const allowed = TOOLS_FOR_CATEGORY[category];
  if (allowed === null) return tools;
  return tools.filter(t => allowed.includes(t.name));
}
