// Slice 58B — L2 content regex sensitivity heuristics.
//
// Pattern bank: SSN, ITIN, EIN, credit cards (Luhn-validated), DOB,
// phone, email, MRN, driver's license, passport, banking. We don't claim
// to find every PII pattern — this is a fast pre-classifier, not a DLP
// engine. Anything with multiple hits typically means restricted; small
// counts of common patterns (one phone number) usually mean internal.

import type { SensitivityTier } from '@cip/shared'

export interface L2Input {
  ocrText: string
}

export interface L2Match {
  type:   string
  count:  number
  /** Tier this match type contributes; final tier is max across all matches. */
  tier:   SensitivityTier
}

export interface L2Output {
  tier:    SensitivityTier
  matches: L2Match[]
}

interface PatternDef {
  type:      string
  rx:        RegExp
  /** Validator callback, e.g. Luhn for credit-card. Returns true to count the match. */
  validate?: (match: string) => boolean
  tier:      SensitivityTier
}

// Patterns are deliberately broad on the regex side; validator narrows
// false positives. Counts cap at 100 per pattern type to bound runtime
// on adversarially-crafted documents.
const PATTERNS: PatternDef[] = [
  // SSN: 3-2-4 digits. Excludes obvious filler (e.g. 000-00-0000) via validator.
  { type: 'ssn',           rx: /\b\d{3}-\d{2}-\d{4}\b/g,
    validate: (m) => !/^0{3}-0{2}-0{4}$/.test(m) && !m.startsWith('666-') && !m.startsWith('9'),
    tier: 'restricted' },
  // ITIN: 9XX-7X-XXXX or 9XX-8X-XXXX
  { type: 'itin',          rx: /\b9\d{2}-(7\d|8\d)-\d{4}\b/g, tier: 'restricted' },
  // EIN: NN-NNNNNNN
  { type: 'ein',           rx: /\b\d{2}-\d{7}\b/g, tier: 'confidential' },
  // Credit card: Luhn-validated
  { type: 'credit_card',   rx: /\b(?:\d[ -]?){13,19}\b/g, validate: luhn, tier: 'restricted' },
  // DOB: a few common formats
  { type: 'dob',           rx: /\b(0[1-9]|1[0-2])[\/\-\.](0[1-9]|[12]\d|3[01])[\/\-\.](19|20)\d{2}\b/g, tier: 'confidential' },
  { type: 'dob_iso',       rx: /\b(19|20)\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/g, tier: 'internal' },
  // Phone: NA + intl, somewhat permissive
  { type: 'phone',         rx: /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g, tier: 'internal' },
  // Email
  { type: 'email',         rx: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, tier: 'internal' },
  // Medical record number — common formats: MRN: 12345 / MRN# 12345 / a 6-9 digit
  // run preceded by 'MRN' or 'PT#' label
  { type: 'mrn',           rx: /\b(MRN|PT|MR)[#:\s]+\d{5,10}\b/gi, tier: 'restricted' },
  // Driver's license — extremely state-specific; we look for "DL" or "DLN" labels
  { type: 'driver_license',rx: /\b(DL|DLN|License No)[#:\s]+[A-Z0-9]{5,15}\b/gi, tier: 'confidential' },
  // Passport — labelled "Passport No" + alphanumeric
  { type: 'passport',      rx: /\b(Passport|Passport No|Passport Number)[#:\s]+[A-Z0-9]{6,12}\b/gi, tier: 'restricted' },
  // Banking account/routing — best-effort label-based catch
  { type: 'bank_routing',  rx: /\b(Routing No|Routing|ABA)[#:\s]+\d{9}\b/gi, tier: 'confidential' },
  { type: 'bank_account',  rx: /\b(Account No|Acct No|Account)[#:\s]+\d{6,17}\b/gi, tier: 'confidential' },
]

function luhn(input: string): boolean {
  const digits = input.replace(/[^0-9]/g, '')
  if (digits.length < 13 || digits.length > 19) return false
  let sum = 0
  let alt = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48
    if (alt) {
      n *= 2
      if (n > 9) n -= 9
    }
    sum += n
    alt = !alt
  }
  return sum % 10 === 0
}

const MAX_COUNT_PER_TYPE = 100

export function l2Score(input: L2Input): L2Output {
  if (!input.ocrText || input.ocrText.length === 0) {
    return { tier: 'public', matches: [] }
  }
  const matches: L2Match[] = []

  for (const p of PATTERNS) {
    let count = 0
    // Reset lastIndex on the global regex between calls.
    p.rx.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = p.rx.exec(input.ocrText)) !== null && count < MAX_COUNT_PER_TYPE) {
      const candidate = m[0]
      if (!p.validate || p.validate(candidate)) {
        count++
      }
      // Guard infinite loops on zero-width matches.
      if (m.index === p.rx.lastIndex) p.rx.lastIndex++
    }
    if (count > 0) {
      matches.push({ type: p.type, count, tier: p.tier })
    }
  }

  let topTier: SensitivityTier = 'public'
  let topRank = 0
  for (const m of matches) {
    const r = TIER_RANKS[m.tier]
    if (r > topRank) { topRank = r; topTier = m.tier }
  }
  return { tier: topTier, matches }
}

const TIER_RANKS: Record<SensitivityTier, number> = {
  public:       0,
  internal:     1,
  confidential: 2,
  restricted:   3,
}
