// Slice 55: extractor for `get_employee_permissions`.
//
// Tool args: {} (no args — caller-scoped via JWT).
//
// Routes "what are my roles", "what permissions do I have", "what can
// I do", "/roles", "/permissions" to a single tool. The tool's response
// includes BOTH roles and permissions, so one extractor covers both
// user phrasings.

import type { Extractor, ExtractionResult } from './types.js';

export const getEmployeePermissionsExtractor: Extractor = {
  toolName: 'get_employee_permissions',
  async extract(_text, _ctx, _deps): Promise<ExtractionResult> {
    return { kind: 'complete', args: {} };
  },
};
