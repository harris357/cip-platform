// Slice 45: heuristic gate-bypass for write-action tool calls.
//
// Returns true ONLY if the user's latest message clearly authorizes the
// SPECIFIC action being attempted. Conservative — when in doubt, return
// false and let the gateWriteAction node fire the confirm interrupt.
//
// Authorization criteria (BOTH must hold):
//   1. The user's text contains a verb from `lg.authorized_write_verbs`.
//   2. The user's text references something in the tool args (an entity
//      name, an email, an ID — any concrete value the tool will act on).
//
// Verb-only is not enough — "create" alone in conversation isn't an
// instruction. Verb + entity name is.

export function isExplicitlyAuthorized(args: {
  userText:        string;
  toolArgs:        Record<string, unknown>;
  authorizedVerbs: string[];
}): boolean {
  const lower = args.userText.toLowerCase();

  // 1. Verb match.
  const verbHit = args.authorizedVerbs.some(v => lower.includes(v.toLowerCase()));
  if (!verbHit) return false;

  // 2. Entity match — any string arg value present in the user text.
  // We check string args (emails, names, codes). UUID args don't count
  // because users rarely paste UUIDs as authorization signals.
  for (const value of Object.values(args.toolArgs)) {
    if (typeof value !== 'string' || value.length < 3) continue;
    if (looksLikeUuid(value)) continue;
    if (lower.includes(value.toLowerCase())) return true;
  }

  return false;
}

function looksLikeUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}
