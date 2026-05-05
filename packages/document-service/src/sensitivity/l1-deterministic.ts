// Slice 58B — L1 deterministic sensitivity heuristics.
//
// Filename keyword scan + uploader hint scan + size heuristic. No LLM,
// no regex over content. Cheap pre-filter before L2 + L3.
//
// Tunable inputs:
//   - documents.l1_keywords (filename keyword triggers, per-tenant)
// Hard-coded:
//   - hint patterns (these match natural-language phrasing; tunable
//     overhead isn't worth it for the bot copy patterns we expect)

import type { SensitivityTier } from '@cip/shared'

export interface L1Input {
  fileName:    string
  mimeType:    string
  sizeBytes:   number
  hintText?:   string
  /** From tunables — case-insensitive substring match on filename. */
  l1Keywords:  string[]
}

export interface L1Hit {
  type:    'filename_keyword' | 'hint_phrase' | 'oversized'
  match:   string
  weight:  SensitivityTier
}

export interface L1Output {
  tier:  SensitivityTier
  hits:  L1Hit[]
}

const HINT_PATTERNS: Array<{ rx: RegExp; tier: SensitivityTier; label: string }> = [
  { rx: /\bfor me\b/i,                     tier: 'internal',     label: 'for_me' },
  { rx: /\bprivate\b/i,                    tier: 'confidential', label: 'private' },
  { rx: /\bconfidential\b/i,               tier: 'confidential', label: 'confidential' },
  { rx: /\bdo not share\b/i,               tier: 'confidential', label: 'do_not_share' },
  { rx: /\bsensitive\b/i,                  tier: 'confidential', label: 'sensitive' },
  { rx: /\bmy ssn\b/i,                     tier: 'restricted',   label: 'my_ssn' },
  { rx: /\bmy paystub\b/i,                 tier: 'confidential', label: 'my_paystub' },
]

// Tier inferred from a keyword — most filename keywords are roughly "internal"
// or "confidential". Restricted is reserved for patterns we're sure about
// (SSN, government IDs, etc.) and is mostly L2/L3 territory.
function tierForKeyword(kw: string): SensitivityTier {
  const k = kw.toLowerCase()
  if (k === 'ssn' || k === 'w2' || k === 'w4' || k === '1099' || k === 'paystub' || k === 'payroll' || k === 'medical') {
    return 'confidential'
  }
  if (k === 'salary' || k === 'nda' || k === 'contract' || k === 'confidential' || k === 'hr-private') {
    return 'confidential'
  }
  return 'internal'
}

export function l1Score(input: L1Input): L1Output {
  const hits: L1Hit[] = []
  const lcName = input.fileName.toLowerCase()

  for (const kw of input.l1Keywords) {
    if (!kw) continue
    if (lcName.includes(kw.toLowerCase())) {
      hits.push({ type: 'filename_keyword', match: kw, weight: tierForKeyword(kw) })
    }
  }

  if (input.hintText) {
    for (const p of HINT_PATTERNS) {
      if (p.rx.test(input.hintText)) {
        hits.push({ type: 'hint_phrase', match: p.label, weight: p.tier })
      }
    }
  }

  // Size heuristic: 50MB+ files often indicate raw-document bundles
  // (multi-page scans, archives) — bumps to internal at minimum.
  if (input.sizeBytes > 50 * 1024 * 1024) {
    hits.push({ type: 'oversized', match: `size>${input.sizeBytes}`, weight: 'internal' })
  }

  // Compose: tier = max of all hits' weights, default 'public' if no hits.
  let topTier: SensitivityTier = 'public'
  let topRank = 0
  for (const h of hits) {
    const r = TIER_RANKS[h.weight]
    if (r > topRank) { topRank = r; topTier = h.weight }
  }
  return { tier: topTier, hits }
}

const TIER_RANKS: Record<SensitivityTier, number> = {
  public:       0,
  internal:     1,
  confidential: 2,
  restricted:   3,
}
