// Slice 58C-FIX — XLSX text extraction via SheetJS.
//
// Each sheet is converted to CSV with a header line indicating the
// sheet name. Sheets are joined with a separator so a downstream LLM
// can parse the boundaries.
//
// xlsx (SheetJS community) ships its own CSV writer that handles
// quoting + cell-type coercion (dates → ISO, numbers → fixed). Good
// enough for the L1/L2 sensitivity scan + classification context.
//
// Lazy import: keeps the ~3MB SheetJS bundle out of any workflow code
// path. Only the activity-side extractor (Node runtime) needs it.

import type { ExtractionResult } from './extract-from-text.js'

const SHEET_SEP = '\n\n--- SHEET: '
const SHEET_END = ' ---\n\n'

export async function extractFromXlsx(buffer: Buffer): Promise<ExtractionResult> {
  const XLSX = await import('xlsx')

  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true, cellNF: false, cellText: true })

  const parts: string[] = []
  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName]
    if (!ws) continue
    const csv = XLSX.utils.sheet_to_csv(ws, { blankrows: false }) ?? ''
    parts.push(`${SHEET_SEP}${sheetName}${SHEET_END}${csv}`)
  }

  return {
    ocrText: parts.join('').trimStart(),
    evidence: {
      source:     'xlsx.sheet_to_csv',
      bytes:      buffer.length,
      sheetCount: wb.SheetNames.length,
      sheets:     wb.SheetNames.slice(0, 50),       // bounded — workbooks with 1000s of sheets exist
    },
  }
}
