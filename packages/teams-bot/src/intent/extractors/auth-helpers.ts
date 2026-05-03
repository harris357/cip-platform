// Slice 55: auth-derived helpers for extractors.
//
// Self-scoped queries ("MY certs", "show MY profile") don't need any
// extraction — the relevant id IS the caller's. These helpers make
// that pattern explicit and avoid every extractor re-deriving it.

import type { BotAuthContext } from '../../auth/resolve-context.js';

/** The caller's own employee_id — for "MY certs" / "I want to" / etc. */
export function useCallerId(ctx: BotAuthContext): string {
  return ctx.employeeId;
}

/**
 * Detect whether the user's text is self-referential. Conservative —
 * only the unambiguous pronouns. "Show me X" is self-referential ONLY
 * when X is also self-shaped (caller's own roles, certs, etc.). Each
 * extractor decides whether self-scoping applies given its tool.
 */
export function isSelfScoped(text: string): boolean {
  return /\b(my|mine|myself|i'm|i am|i)\b/i.test(text);
}
