// Slice 58D-A — combine pg_trgm shortlist score with structured-hint
// matches into a final per-candidate score.
//
// Pure function — no I/O. The shortlist already supplied a similarity
// score (0..1) over employees.full_name; this activity bumps it for
// soft hints we have signal on (department, role, email match if the
// shortlist was loose). Always returns scores clamped to [0, 1].
//
// Today the only structural bonus we know how to apply is the
// department string match — slice 58D-A doesn't load department onto
// the shortlist row (it'd require a JOIN against a future
// employee_departments table or a JSON column we don't have yet), so
// the score function is conservative: it returns trgm-similarity as-is
// and exposes a structured `breakdown` object so the workflow's
// evidence trail records what was considered.

import { z } from 'zod';

import {
  PersonScoredCandidateSchema,
  PersonShortlistCandidateSchema,
  type PersonScoredCandidate,
} from '@cip/shared';
import { CanonicalizationSchema } from './canonicalize-person-hint.activity.js';

export const ScoreCandidatesInputSchema = z.object({
  canonicalization: CanonicalizationSchema,
  shortlist:        z.array(PersonShortlistCandidateSchema),
});
export type ScoreCandidatesInput = z.infer<typeof ScoreCandidatesInputSchema>;

export async function scoreCandidatesActivity(
  input: ScoreCandidatesInput,
): Promise<PersonScoredCandidate[]> {
  const validated = ScoreCandidatesInputSchema.parse(input);

  const scored: PersonScoredCandidate[] = validated.shortlist.map(c => {
    const trgm = c.score;

    // Bonus components recorded in the breakdown for audit; with no
    // department/role joinable today, only `trgm` carries signal. The
    // structure is here so 58D follow-ups (loading employee.department
    // alongside the shortlist) plug in additional bonuses without
    // changing the contract.
    const breakdown: Record<string, number> = { trgm };

    // Inactive penalty: drop active=false candidates by 50% so they
    // surface only when nothing active scores well. (Workflow filtered
    // out the set when includeInactive=false; this guards the
    // includeInactive=true historical path.)
    let final = trgm;
    if (!c.active) {
      final = trgm * 0.5;
      breakdown['inactive_penalty'] = -trgm * 0.5;
    }

    final = Math.max(0, Math.min(1, final));

    return PersonScoredCandidateSchema.parse({
      employeeId: c.employeeId,
      fullName:   c.fullName,
      score:      final,
      breakdown,
    });
  });

  // Stable sort by score DESC — keeps deterministic replay if two
  // candidates tie exactly.
  scored.sort((a, b) => b.score - a.score);
  return scored;
}
