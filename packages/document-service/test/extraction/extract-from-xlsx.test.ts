// Slice 58C-FIX — XLSX extraction.

import { describe, it, expect } from 'vitest'
import * as XLSX from 'xlsx'

import { extractFromXlsx } from '../../src/extraction/extract-from-xlsx.js'

function makeTinyXlsx(): Buffer {
  const wb = XLSX.utils.book_new()

  const ws1 = XLSX.utils.aoa_to_sheet([
    ['Name',   'Cert',           'Expires'],
    ['Alice',  'WHS Induction',  '2025-06-30'],
    ['Bob',    'CPR',            '2025-09-01'],
  ])
  XLSX.utils.book_append_sheet(wb, ws1, 'Roster')

  const ws2 = XLSX.utils.aoa_to_sheet([
    ['Notes'],
    ['Bulk import from Acme'],
  ])
  XLSX.utils.book_append_sheet(wb, ws2, 'Meta')

  // SheetJS returns ArrayBuffer when type='buffer'; coerce to Node Buffer.
  const out = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer
  return out
}

describe('extractFromXlsx', () => {
  it('emits CSV-shaped text per sheet with separators', async () => {
    const buf = makeTinyXlsx()
    const r = await extractFromXlsx(buf)
    expect(r.ocrText).toContain('--- SHEET: Roster ---')
    expect(r.ocrText).toContain('--- SHEET: Meta ---')
    expect(r.ocrText).toContain('Alice,WHS Induction,2025-06-30')
    expect(r.ocrText).toContain('Bob,CPR,2025-09-01')
    expect(r.ocrText).toContain('Bulk import from Acme')
    expect(r.evidence.source).toBe('xlsx.sheet_to_csv')
    expect(r.evidence.sheetCount).toBe(2)
  })
})
