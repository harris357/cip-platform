// Slice 58D-A — fallback prompt for `hr.people.canonicalize`.
//
// Slice 41 pattern: production traffic reads the prompt from Langfuse
// (label='production'); on Langfuse outage / missing entry / fetch error
// the canonicalize activity falls through to this byte-identical baked
// copy. Keep this in sync with the Langfuse production version.
//
// Variables: {{ candidateText }}, {{ structuredHints }}
//   - candidateText: free-form hint string from the caller (e.g. cert
//     uploader's text "for John from ops"). May be empty.
//   - structuredHints: JSON-stringified hint object or '(none)'.
//
// Output contract: the canonicalize activity expects a single JSON
// object with the keys firstName / lastName / email / department /
// role — all optional. Any extra prose breaks the JSON parser; the
// prompt is deliberately strict.

export const HR_PEOPLE_CANONICALIZE_FALLBACK = `
You are a name-canonicalization helper for an HR person-matching workflow.
Given a free-form hint and any structured hints already extracted, normalise
to a structured object that downstream similarity scoring can use against
employee.full_name.

Input
  Hint text:        {{ candidateText }}
  Structured hints: {{ structuredHints }}

Rules
  - Expand common nicknames to canonical forms ONLY when unambiguous
    (e.g. "Bob" -> "Robert"; "Mike" -> "Michael"). Leave ambiguous
    ones as-is.
  - If only a first name is given, leave lastName null.
  - Respect explicit structured hints over guesses from candidateText.
  - Lowercase email if present.
  - Department / role only if clearly stated in the hint.
  - DO NOT invent fields. Empty/unknown -> omit the key entirely.

Reply with ONLY a JSON object. No prose, no code fences.

Example outputs:
  {"firstName":"Robert","lastName":"Smith"}
  {"firstName":"John","department":"Operations"}
  {"email":"alice@example.com"}
  {}
`.trim();
