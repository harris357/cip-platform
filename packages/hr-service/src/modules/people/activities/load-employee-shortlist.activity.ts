// Slice 58D-A — pg_trgm shortlist of employees against a canonicalized
// name surface.
//
// Composes the canonicalization output into a single search string,
// then runs Postgres `similarity()` over `employees.full_name` (GIN
// trgm index from migration 042). Returns the top N candidates ordered
// by score descending.
//
// Active-only by default — `disabled_at IS NULL` per the slice 33
// employee disable model. Callers explicitly set includeInactive=true
// for historical lookups.

import { z } from 'zod';

import { getDb, type Db } from '../../../db/index.js';
import { withTenantRLS } from '../../../db/rls.js';
import { sql } from 'drizzle-orm';

import { PersonShortlistCandidateSchema, type PersonShortlistCandidate } from '@cip/shared';
import { CanonicalizationSchema, type Canonicalization } from './canonicalize-person-hint.activity.js';

export const LoadEmployeeShortlistInputSchema = z.object({
  tenantId:        z.string().uuid(),
  candidateText:   z.string(),
  canonicalized:   CanonicalizationSchema,
  includeInactive: z.boolean(),
  max:             z.number().int().positive(),
});
export type LoadEmployeeShortlistInput = z.infer<typeof LoadEmployeeShortlistInputSchema>;

/** Build the search string the canonicalization output should be
 *  scored against. Prefer "first last" when both present; fall through
 *  to the raw candidateText so a hint like "John from ops" still
 *  yields a usable similarity probe. */
function buildSearchString(args: {
  candidateText: string;
  canon:         Canonicalization;
}): string {
  const parts: string[] = [];
  if (args.canon.firstName) parts.push(args.canon.firstName);
  if (args.canon.lastName)  parts.push(args.canon.lastName);
  if (parts.length > 0) return parts.join(' ');
  return args.candidateText.trim();
}

export async function loadEmployeeShortlistActivity(
  input: LoadEmployeeShortlistInput,
): Promise<PersonShortlistCandidate[]> {
  const validated = LoadEmployeeShortlistInputSchema.parse(input);

  const search = buildSearchString({
    candidateText: validated.candidateText,
    canon:         validated.canonicalized,
  });

  if (!search) return [];

  const db = getDb();
  const rows = await withTenantRLS(db, validated.tenantId, async (tx: Db) => {
    // Raw SQL — drizzle's typed builder doesn't support trigram operators.
    // RLS GUC is set by withTenantRLS so the tenant filter is implicit;
    // we keep the explicit tenant_id WHERE for clarity / index hit.
    // The activeFilter sits inside the WHERE and only applies when
    // includeInactive=false.
    const activeFilter = validated.includeInactive
      ? sql``
      : sql`AND disabled_at IS NULL`;
    const result = await tx.execute<{
      id: string;
      full_name: string;
      score: number;
      active: boolean;
    }>(sql`
      SELECT id, full_name, similarity(full_name, ${search}) AS score,
             (disabled_at IS NULL) AS active
        FROM employees
       WHERE tenant_id = ${validated.tenantId}::uuid
         AND similarity(full_name, ${search}) > 0
         ${activeFilter}
       ORDER BY score DESC
       LIMIT ${validated.max}
    `);
    // drizzle's pg-driver execute returns { rows } on node-postgres.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = (result as any).rows ?? result;
    return r as Array<{ id: string; full_name: string; score: number; active: boolean }>;
  });

  return rows.map(r => PersonShortlistCandidateSchema.parse({
    employeeId: r.id,
    fullName:   r.full_name,
    score:      Number(r.score),
    active:     Boolean(r.active),
  }));
}
