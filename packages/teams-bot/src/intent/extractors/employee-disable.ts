// Slice 55: extractor for `employee_disable`.
//
// Tool args: { employeeId: UUID, reason?: string }
//
// Strategy:
//   1. resolveEmployeeByNameOrEmail (email → exact, name → ILIKE)
//      - 1 hit → complete
//      - >1 hit → ambiguous (disambiguation card)
//      - 0 hits → missing (templated clarification)
//   2. Optional reason via "reason ..." / "because ..." / etc.

import { resolveEmployeeByNameOrEmail } from './db-helpers.js';
import type { Extractor, ExtractionResult } from './types.js';

function extractReason(text: string): string | undefined {
  const m = text.match(/(?:reason|because|due\s+to|for\s+cause)\s+["']?([^"'\n.!?]+)["']?/i);
  return m?.[1]?.trim();
}

export const employeeDisableExtractor: Extractor = {
  toolName: 'employee_disable',
  async extract(text, ctx, { pool }): Promise<ExtractionResult> {
    const resolved = await resolveEmployeeByNameOrEmail(text, ctx, pool);
    const reason = extractReason(text);
    if (resolved.kind === 'none')      return { kind: 'missing', missing: ['employeeId'] };
    if (resolved.kind === 'ambiguous') return { kind: 'ambiguous', argName: 'employeeId', candidates: resolved.candidates };
    return {
      kind: 'complete',
      args: {
        employeeId: resolved.value.id,
        ...(reason ? { reason } : {}),
      },
    };
  },
};
