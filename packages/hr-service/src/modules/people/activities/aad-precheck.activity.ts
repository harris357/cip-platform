// Slice 58D-A — AAD pre-check (self-pick fast path).
//
// If the candidate text reads as self-referential ("for me", "this is
// mine", "my own", etc.) AND the uploader's AAD object id maps to an
// active employee in the tenant, return the employee immediately. No
// LLM call, no shortlist, no Langfuse trace.
//
// Phrase detection is a tiny code-resident regex set rather than a DB
// table or LLM — the fast path is only worth it if it's actually fast.
// English-only for now; future i18n adds the patterns or pushes
// detection into the canonicalizer.

import { z } from 'zod';
import { eq, and, isNull, sql } from 'drizzle-orm';

import { getDb, type Db } from '../../../db/index.js';
import { withTenantRLS } from '../../../db/rls.js';
import { employees, userIdentityLinks } from '../../../db/schema.js';

// Self-referential phrases. Tested against the lower-cased candidate
// text after collapsing whitespace. Order doesn't matter — we OR them.
const SELF_PATTERNS: RegExp[] = [
  /\bfor me\b/,
  /\bthis is mine\b/,
  /\bthis is for me\b/,
  /\bmy own\b/,
  /\bmy ?(?:cert|certificate|cpr|card|document|doc)\b/,
  /\bi am the (?:holder|subject|person)\b/,
  /\bit'?s for me\b/,
];

function isSelfReferential(text: string): boolean {
  if (!text) return false;
  const normalised = text.toLowerCase().replace(/\s+/g, ' ').trim();
  return SELF_PATTERNS.some(p => p.test(normalised));
}

export const AadPrecheckInputSchema = z.object({
  tenantId:           z.string().uuid(),
  candidateText:      z.string(),
  uploaderEmployeeId: z.string().optional(),
});
export type AadPrecheckInput = z.infer<typeof AadPrecheckInputSchema>;

export const AadPrecheckOutputSchema = z.object({
  employeeId: z.string().uuid(),
  matchedBy:  z.literal('aad_self_referential'),
}).nullable();
export type AadPrecheckOutput = z.infer<typeof AadPrecheckOutputSchema>;

export async function aadPrecheckActivity(
  input: AadPrecheckInput,
): Promise<AadPrecheckOutput> {
  const validated = AadPrecheckInputSchema.parse(input);

  if (!validated.uploaderEmployeeId) return null;
  if (!isSelfReferential(validated.candidateText)) return null;

  const db = getDb();
  const uploaderEmployeeId = validated.uploaderEmployeeId;
  // Slice 65: AAD subject moved to user_identity_links. JOIN on user_id.
  const rows = await withTenantRLS(db, validated.tenantId, (tx: Db) =>
    tx
      .select({ id: employees.id })
      .from(employees)
      .innerJoin(userIdentityLinks, eq(userIdentityLinks.userId, employees.userId))
      .where(and(
        eq(employees.tenantId, validated.tenantId),
        eq(userIdentityLinks.provider, 'aad'),
        eq(userIdentityLinks.subject, uploaderEmployeeId),
        // Active = disabled_at IS NULL (slice 33 model).
        isNull(employees.disabledAt),
      ))
      .limit(1),
  );

  const employeeId = rows[0]?.id;
  if (!employeeId) return null;

  return AadPrecheckOutputSchema.parse({
    employeeId,
    matchedBy: 'aad_self_referential',
  });
}

// Re-export for tests / diagnostic scripts that want to probe the regex
// set without standing up a DB.
export { isSelfReferential as _isSelfReferential };
// Use sql import to avoid "imported but unused" if drizzle's types ever
// shake out differently (pattern matches the schema.ts conservatism).
void sql;
