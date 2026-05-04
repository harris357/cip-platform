// Slice 55: grammar patterns for the deterministic fast-path router.
//
// Each pattern is a regex + the tool whose extractor handles it. The
// matcher returns the FIRST hit (specificity-ordered: slash commands
// before verb-object phrases).
//
// Adding a pattern: append below + ensure an extractor exists for the
// referenced toolName. `make extractor-coverage` flags missing pairs.

export interface GrammarPattern {
  /** Human-readable name for telemetry (`grammar_pattern` column). */
  name:     string;
  /** The regex. Case-insensitive by default. */
  pattern:  RegExp;
  /** Tool whose extractor will be invoked on a match. */
  toolName: string;
}

export const GRAMMAR_PATTERNS: GrammarPattern[] = [
  // ─── Slash-style — exact verb + identifier. Highest specificity. ──
  // Order matters: more-specific (slash_my_certs) before more-general (slash_certs).
  { name: 'slash_disable',     pattern: /^\/disable\s+(\S+)/i,                  toolName: 'employee_disable' },
  { name: 'slash_my_certs',    pattern: /^\/(mycerts|certs)\s*$/i,              toolName: 'get_my_certifications' },
  { name: 'slash_staff_certs', pattern: /^\/certs\s+(\S+)/i,                    toolName: 'get_staff_certifications' },
  { name: 'slash_staff',       pattern: /^\/(staff|employees|list)(\s|$)/i,     toolName: 'employee_list' },
  { name: 'slash_my_roles',    pattern: /^\/(roles|myroles|permissions|myperms)\s*$/i, toolName: 'get_employee_permissions' },

  // ─── Verb-object — caller's own certs (self-scoped) ────────────────
  // "show my certs" / "what are my certifications" / etc.
  // Self-scoped patterns must run BEFORE generic cert patterns.
  { name: 'verb_my_certs',
    pattern: /\b(show|view|see|list|get|what(?:'s|\s+are))?\s*my\s+certs?(?:ifications?)?\b/i,
    toolName: 'get_my_certifications' },

  // ─── Verb-object — caller's own roles + permissions ────────────────
  // The tool returns BOTH roles and permissions; one extractor handles
  // both phrasings.
  { name: 'verb_my_roles',
    pattern: /\b(show|view|see|list|get|what(?:'s|\s+are))?\s*my\s+roles?\b/i,
    toolName: 'get_employee_permissions' },
  { name: 'verb_my_permissions',
    pattern: /\b(show|view|see|list|get|what(?:'s|\s+are))?\s*my\s+(permissions?|perms|access|privileges?)\b/i,
    toolName: 'get_employee_permissions' },
  { name: 'verb_what_can_i_do',
    pattern: /\bwhat\s+(can|am\s+i\s+able\s+to)\s+(i\s+)?do\b/i,
    toolName: 'get_employee_permissions' },

  // ─── Verb-object — write actions ───────────────────────────────────
  // "off-board Sarah", "disable bob@x.com", "fire Tom Jones"
  { name: 'verb_disable',
    pattern: /\b(off-?board|disable|deactivate|terminate|fire)\s+\S+/i,
    toolName: 'employee_disable' },

  // ─── Verb-object — read someone else's certs ───────────────────────
  // "show Jane's certs" / "what certs does Bob have"
  { name: 'verb_staff_certs',
    pattern: /\b(show|view|see|list|get|what)\s+.{0,30}(certs?|certifications?)\b.*\b(for|of|does)\b/i,
    toolName: 'get_staff_certifications' },

  // ─── Verb-object — list employees ──────────────────────────────────
  { name: 'verb_list_staff',
    pattern: /\b(list|show|find)\s+.{0,30}(staff|employees|team|everyone)/i,
    toolName: 'employee_list' },

  // ─── Verb-object — find a specific employee by email ───────────────
  { name: 'verb_find_employee',
    pattern: /\b(find|lookup|search\s+for)\s+[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i,
    toolName: 'employee_find' },
];

/** Returns the first matching pattern, or null. Patterns ordered by specificity. */
export function matchGrammar(text: string): GrammarPattern | null {
  for (const p of GRAMMAR_PATTERNS) {
    if (p.pattern.test(text)) return p;
  }
  return null;
}
