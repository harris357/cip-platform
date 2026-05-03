// Slice 55: extractor for `get_staff_certifications`.
//
// Tool args: { employeeId: UUID }
//
// Strategy: same as employee_disable — resolve a name/email mention
// to an employeeId via DB lookup. Self-scoped phrasings should not
// reach this extractor (the grammar router routes them to
// `get_my_certifications` first).

import { resolveEmployeeByNameOrEmail } from './db-helpers.js';
import type { Extractor, ExtractionResult } from './types.js';

export const getStaffCertificationsExtractor: Extractor = {
  toolName: 'get_staff_certifications',
  async extract(text, ctx, { pool }): Promise<ExtractionResult> {
    const resolved = await resolveEmployeeByNameOrEmail(text, ctx, pool);
    if (resolved.kind === 'none')      return { kind: 'missing', missing: ['employeeId'] };
    if (resolved.kind === 'ambiguous') return { kind: 'ambiguous', argName: 'employeeId', candidates: resolved.candidates };
    return { kind: 'complete', args: { employeeId: resolved.value.id } };
  },
};
