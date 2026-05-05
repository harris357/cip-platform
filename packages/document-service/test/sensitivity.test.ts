// Slice 58B — sensitivity unit tests (L1 + L2 + tier composer).
//
// L3 is excluded — it requires a live LLM and is exercised end-to-end
// against the cluster, not in unit tests.

import { describe, it, expect } from 'vitest'
import { l1Score } from '../src/sensitivity/l1-deterministic.js'
import { l2Score } from '../src/sensitivity/l2-regex.js'
import { maxTier } from '../src/sensitivity/tier-compose.js'
import { DEFAULTS } from '../src/sensitivity/tunables.js'

describe('l1 deterministic', () => {
  it('public default for benign filename + no hint', () => {
    const r = l1Score({
      fileName: 'meeting-notes.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 200_000,
      l1Keywords: DEFAULTS.l1Keywords,
    })
    expect(r.tier).toBe('public')
    expect(r.hits).toEqual([])
  })

  it('filename keyword bumps to confidential', () => {
    const r = l1Score({
      fileName: 'jane-doe-paystub-2024.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 100_000,
      l1Keywords: DEFAULTS.l1Keywords,
    })
    expect(r.tier).toBe('confidential')
    expect(r.hits.some(h => h.match === 'paystub')).toBe(true)
  })

  it('hint phrase "private" → confidential', () => {
    const r = l1Score({
      fileName: 'doc.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 100_000,
      hintText: 'this is private',
      l1Keywords: DEFAULTS.l1Keywords,
    })
    expect(r.tier).toBe('confidential')
  })

  it('takes max tier across multiple hits', () => {
    const r = l1Score({
      fileName: 'salary.pdf',         // internal (per tierForKeyword)
      mimeType: 'application/pdf',
      sizeBytes: 100_000,
      hintText: 'do not share',       // confidential
      l1Keywords: DEFAULTS.l1Keywords,
    })
    expect(r.tier).toBe('confidential')
  })
})

describe('l2 regex', () => {
  it('public default for empty text', () => {
    const r = l2Score({ ocrText: '' })
    expect(r.tier).toBe('public')
    expect(r.matches).toEqual([])
  })

  it('detects SSN as restricted', () => {
    const r = l2Score({ ocrText: 'SSN: 123-45-6789 is here' })
    expect(r.tier).toBe('restricted')
    expect(r.matches.some(m => m.type === 'ssn')).toBe(true)
  })

  it('Luhn-validated credit card → restricted', () => {
    // 4111 1111 1111 1111 is the canonical Visa Luhn-passing test number
    const r = l2Score({ ocrText: 'Card: 4111 1111 1111 1111 expires soon' })
    expect(r.tier).toBe('restricted')
    expect(r.matches.some(m => m.type === 'credit_card')).toBe(true)
  })

  it('plain email + phone → internal', () => {
    const r = l2Score({ ocrText: 'Reach me at jane@example.com or 555-123-4567' })
    expect(r.tier).toBe('internal')
  })

  it('rejects obviously-fake SSNs (000-00-0000)', () => {
    const r = l2Score({ ocrText: 'TEST 000-00-0000 placeholder' })
    expect(r.matches.some(m => m.type === 'ssn')).toBe(false)
  })
})

describe('tier composer', () => {
  it('maxTier picks the most-sensitive value', () => {
    expect(maxTier('public', 'internal', 'confidential')).toBe('confidential')
    expect(maxTier('internal', 'restricted')).toBe('restricted')
    expect(maxTier('public', undefined, 'public')).toBe('public')
  })
})
