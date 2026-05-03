// Slice 55: extractor for `employee_find`.
//
// Tool args: { email: string } — exact match required.
//
// Strategy: simple email regex, no DB lookup needed (the tool itself
// does the lookup). Missing if no email pattern detected.

import type { Extractor, ExtractionResult } from './types.js';

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;

export const employeeFindExtractor: Extractor = {
  toolName: 'employee_find',
  async extract(text, _ctx, _deps): Promise<ExtractionResult> {
    const m = text.match(EMAIL_RE);
    if (!m) return { kind: 'missing', missing: ['email'] };
    return { kind: 'complete', args: { email: m[0].toLowerCase() } };
  },
};
