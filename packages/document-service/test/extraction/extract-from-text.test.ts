// Slice 58C-FIX — plain text round-trip + token-budget truncation.

import { describe, it, expect } from 'vitest'
import { extractFromText } from '../../src/extraction/extract-from-text.js'
import { truncateToBudget } from '../../src/extraction/token-budget.js'

describe('extractFromText', () => {
  it('UTF-8 round-trip', async () => {
    const buf = Buffer.from('Hello, world! ¡Olé! 你好。', 'utf-8')
    const r = await extractFromText(buf)
    expect(r.ocrText).toBe('Hello, world! ¡Olé! 你好。')
    expect(r.evidence.source).toBe('plain_text')
  })

  it('strips UTF-8 BOM', async () => {
    const buf = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('hello', 'utf-8')])
    const r = await extractFromText(buf)
    expect(r.ocrText).toBe('hello')
  })

  it('preserves CSV layout', async () => {
    const csv = 'name,age\nalice,30\nbob,40\n'
    const r = await extractFromText(Buffer.from(csv, 'utf-8'))
    expect(r.ocrText).toBe(csv)
  })

  it('handles empty buffer', async () => {
    const r = await extractFromText(Buffer.alloc(0))
    expect(r.ocrText).toBe('')
    expect(r.evidence.bytes).toBe(0)
  })
})

describe('truncateToBudget', () => {
  it('passes through under budget', () => {
    expect(truncateToBudget('hello', 100)).toBe('hello')
  })
  it('appends truncation marker over budget', () => {
    const long = 'x'.repeat(50)
    const r = truncateToBudget(long, 10)
    expect(r.startsWith('xxxxxxxxxx')).toBe(true)
    expect(r.endsWith('[truncated]')).toBe(true)
    expect(r.length).toBeLessThan(long.length)
  })
  it('handles empty input', () => {
    expect(truncateToBudget('', 100)).toBe('')
  })
  it('handles zero budget', () => {
    expect(truncateToBudget('hello', 0)).toBe('')
  })
})
