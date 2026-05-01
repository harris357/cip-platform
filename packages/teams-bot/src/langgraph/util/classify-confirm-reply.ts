// Slice 46b: shared affirmation/cancellation classifier.
//
// Used by the `confirm` node when the user replies to a write-action
// prompt. Patterns are tunables (lg.affirmation_patterns,
// lg.cancellation_patterns) — pass the resolved arrays in.

export type ConfirmVerdict = 'affirm' | 'cancel' | 'unrecognized';

export function classifyConfirmReply(
  userText:      string,
  affirmPatterns: string[],
  cancelPatterns: string[],
): ConfirmVerdict {
  const lower = userText.trim().toLowerCase();
  const matches = (patterns: string[]): boolean =>
    patterns.some(p =>
      lower === p || lower.startsWith(`${p} `) || lower.endsWith(` ${p}`),
    );
  if (matches(affirmPatterns)) return 'affirm';
  if (matches(cancelPatterns)) return 'cancel';
  return 'unrecognized';
}
