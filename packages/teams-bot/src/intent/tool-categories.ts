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
 * Slice 41 enrichment: human-readable description for each category.
 * Becomes the source of truth fed to the classifier prompt — the
 * `{% for c in categories %}` block iterates {name, description} pairs
 * from this map, filtered by `availableCategories(tools)`. Adding a
 * new category here automatically flows through to the classifier
 * prompt's enum without an additional edit.
 */
export const CATEGORY_DESCRIPTIONS: Record<Category, string> = {
  chitchat:    'greetings, thanks, social pleasantries. Emit a brief friendly inline_reply (1 sentence).',
  meta:        'questions about the bot itself ("what can you do?", "help"). Emit a one-paragraph inline_reply describing the bot\'s capabilities at a high level.',
  cert_query:  'the user wants to read certification or compliance data.',
  cert_action: 'the user wants to upload/submit/approve a certificate.',
  hr_admin:    'the user wants to manage employees, roles, or permissions.',
  reasoning:   'multi-step intents that span categories, or anything unclear. Use sparingly — only when no single category fits.',
};

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

/**
 * Slice 41 enrichment: which categories have at least one permitted tool
 * for this caller? Drives the dynamic list passed to the classifier
 * prompt. Single source of truth — derives from the (already-permission-
 * filtered) tool list + TOOLS_FOR_CATEGORY. Adding a new category is
 * a one-file edit.
 *
 * `chitchat`, `meta`, `reasoning` are always available (no tool gating).
 * Categories with `null` in TOOLS_FOR_CATEGORY are treated as
 * always-available (chitchat/meta produce inline replies; reasoning
 * uses the full catalog as a multi-step fallback).
 */
export function availableCategories(tools: McpTool[]): Category[] {
  return CATEGORIES.filter(cat => {
    const tools_for = TOOLS_FOR_CATEGORY[cat];
    if (tools_for === null) return true;       // chitchat/meta/reasoning
    return filterToolsByCategory(tools, cat).length > 0;
  });
}

/**
 * Slice 41 enrichment: produces the {name, description} list that the
 * classifier prompt iterates over with `{% for c in categories %}`.
 * The single representation passed to the LLM — no per-category
 * boolean flags to keep in sync.
 */
export function categoryListForClassifier(
  tools: McpTool[],
): Array<{ name: Category; description: string }> {
  return availableCategories(tools).map(name => ({
    name,
    description: CATEGORY_DESCRIPTIONS[name],
  }));
}
