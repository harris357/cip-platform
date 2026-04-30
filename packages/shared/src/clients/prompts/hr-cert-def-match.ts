// Slice 41: fallback for `hr-service.cert_def_match`. Byte-identical
// behaviour to today's inline string in match-cert-definition.activity.ts.
//
// Same {{candidates}} pre-formatted-string pattern as hr-employee-match.

export const HR_CERT_DEF_MATCH = `
Match a certificate name extracted via OCR to a certificate library.

Extracted name (may contain OCR errors or abbreviations):
  "{{ certName }}"

Certificate library:
{{ library }}

If one entry is clearly the same certificate, reply with ONLY its REF number (the integer after "REF=").
Common variations to recognise: abbreviations (WHMIS, H2S, CPR), OCR errors, reordered words.
If you are not confident, reply with exactly: NO_MATCH
Do not explain.
`.trim();
