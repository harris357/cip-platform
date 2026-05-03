// Slice 55: extractor for `get_my_certifications`.
//
// Tool args: {} (no args — server uses caller's id from JWT)
//
// Always succeeds with empty args — the tool is always self-scoped.

import type { Extractor, ExtractionResult } from './types.js';

export const getMyCertificationsExtractor: Extractor = {
  toolName: 'get_my_certifications',
  async extract(_text, _ctx, _deps): Promise<ExtractionResult> {
    return { kind: 'complete', args: {} };
  },
};
