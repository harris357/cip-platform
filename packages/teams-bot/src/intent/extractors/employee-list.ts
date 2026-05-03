// Slice 55: extractor for `employee_list`.
//
// Tool args: { identityType?, status?, limit? } — all optional.
//
// We extract:
//   - identityType: 'aad_federated' | 'field_employee' from explicit mentions
//   - status: 'active' | 'disabled' from "disabled" / "off-boarded" mentions
//   - limit: stays at default (50) — extractor doesn't try to set it
//
// Always returns 'complete' — empty args run the tool with defaults.

import type { Extractor, ExtractionResult } from './types.js';

export const employeeListExtractor: Extractor = {
  toolName: 'employee_list',
  async extract(text, _ctx, _deps): Promise<ExtractionResult> {
    const args: Record<string, unknown> = {};
    const lower = text.toLowerCase();

    if (/\b(field\s*workers?|field\s*employees?)\b/.test(lower)) args['identityType'] = 'field_employee';
    else if (/\b(aad|federated|sso\s+users?)\b/.test(lower))     args['identityType'] = 'aad_federated';

    if (/\b(disabled|off-?boarded|inactive|terminated)\b/.test(lower))   args['status'] = 'disabled';
    else if (/\b(active|enabled|current)\b/.test(lower))                  args['status'] = 'active';

    return { kind: 'complete', args };
  },
};
