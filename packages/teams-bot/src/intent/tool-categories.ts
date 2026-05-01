// Slice 43: collapsed intent enum. The hardcoded "category" layer
// (six business labels + per-category tool subsets + per-category
// Stage-2 aliases) is gone — it was a hand-curated registry that
// drifted every time we added tools and caused the recurring
// "wrong tool subset / no candidate" bugs.
//
// Routing is now:
//   chitchat → LLM-authored inline_reply (free-form social)
//   meta     → dedicated meta_compose LLM call (composes a menu from
//              the user's permitted tool list, no static map)
//   proceed  → router LLM does function calling over the *full*
//              permission-filtered tool catalog
//
// Tool-vs-tool disambiguation moves to where it belongs: the tool
// description (scope/audience/output/sibling-disambiguation, see
// SLICE_43_REMOVE_CATEGORY_LAYER.md). No hand-maintained category map.

import type { Tool as McpTool } from '@modelcontextprotocol/sdk/types.js';

export const INTENTS = ['chitchat', 'meta', 'proceed'] as const;
export type Intent = (typeof INTENTS)[number];

/**
 * Which intents are usable for the calling user? `chitchat` and `meta`
 * are always available (they don't require any tool). `proceed` is
 * available iff the user has at least one permitted tool — without
 * tools there's nothing for the router to pick.
 *
 * Drives the (small) dynamic list passed into the classifier prompt:
 * a user with zero permitted tools shouldn't be told the bot can
 * "proceed" with their request, because there's nothing to do.
 */
export function availableIntents(tools: McpTool[]): Intent[] {
  if (tools.length === 0) return ['chitchat', 'meta'];
  return ['chitchat', 'meta', 'proceed'];
}
