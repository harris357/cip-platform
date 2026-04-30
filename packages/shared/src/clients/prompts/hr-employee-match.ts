// Slice 41: fallback for `hr-service.employee_match`. Byte-identical
// behaviour to today's inline string in match-employee.activity.ts.
//
// `candidates` is rendered by the call site as a multi-line string
// (one entry per line, "REF=N | Name=… | Email=…") and substituted
// via Jinja2 {{candidates}}. The Langfuse `production` version can
// evolve to take a raw array and iterate with {% for c in candidates %}
// — operators tweak that in the UI; this fallback stays flat.

export const HR_EMPLOYEE_MATCH = `
Match a certificate holder to one of these candidates.

Certificate holder:
  Name:  {{ extractedName }}
  Email: {{ extractedEmail }}

Candidates:
{{ candidates }}

If one candidate is clearly the same person, reply with ONLY their REF number (the integer after "REF=").
If you are not confident, reply with exactly: NO_MATCH
Do not explain.
`.trim();
