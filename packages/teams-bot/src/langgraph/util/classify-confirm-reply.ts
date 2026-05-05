// Slice 46b + 53: shared affirmation/cancellation classifier.
//
// Used by the `confirm` node when the user resolves a write-action
// suspension. Two callers produce two payload shapes:
//
//   - Slice 46b text-mode: the user types a free-form reply ("yes",
//     "do it", "actually no"); patterns are tunables
//     (lg.affirmation_patterns, lg.cancellation_patterns) — pass the
//     resolved arrays in.
//
//   - Slice 53 card-mode: a structured `{ decision: 'confirm' | 'cancel' }`
//     comes back from the invoke handler's resume call. No pattern
//     match needed — the value IS the verdict.
//
// This helper accepts either shape and returns a normalised verdict
// so confirmNode doesn't have to branch on the input type.

export type ConfirmVerdict = 'affirm' | 'cancel' | 'unrecognized';

export type ConfirmInput =
  | string
  | { decision: 'confirm' | 'cancel' };

export function classifyConfirmReply(
  input:          ConfirmInput,
  affirmPatterns: string[],
  cancelPatterns: string[],
): ConfirmVerdict {
  // Slice 53 card-mode: structured payload short-circuits the matcher.
  // The card UI exposes only [Confirm] [Cancel] so any other value
  // here is a programmer error worth surfacing rather than swallowing.
  if (typeof input === 'object' && input !== null && typeof input.decision === 'string') {
    if (input.decision === 'confirm') return 'affirm';
    if (input.decision === 'cancel')  return 'cancel';
    return 'unrecognized';
  }

  if (typeof input !== 'string') return 'unrecognized';

  const lower = input.trim().toLowerCase();
  const matches = (patterns: string[]): boolean =>
    patterns.some(p =>
      lower === p || lower.startsWith(`${p} `) || lower.endsWith(` ${p}`),
    );
  if (matches(affirmPatterns)) return 'affirm';
  if (matches(cancelPatterns)) return 'cancel';
  return 'unrecognized';
}
