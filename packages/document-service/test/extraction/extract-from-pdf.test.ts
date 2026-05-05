// Slice 58C-FIX — PDF text-layer extraction.
//
// We build a tiny text-layer PDF inline (no fixture file). This exercises
// the happy path where pdfjs's text layer returns enough chars to skip
// the render fallback. The render-fallback path requires live LiteLLM
// and is verified manually post-deploy.

import { describe, it, expect } from 'vitest'
import { extractFromPdf } from '../../src/extraction/extract-from-pdf.js'

// Minimal valid 1-page PDF with an embedded text-layer 'Hello World' in
// Helvetica. Hand-rolled (xref offsets adjusted per content). This is a
// well-formed PDF that pdfjs-dist parses cleanly — same shape pdfkit/
// puppeteer outputs, just minus the metadata stream.
function makeTinyTextPdf(text: string): Buffer {
  const stream = `BT\n/F1 12 Tf\n72 720 Td\n(${text}) Tj\nET\n`
  const objs: string[] = []
  objs.push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n')
  objs.push('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n')
  objs.push('3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n')
  objs.push(`4 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}endstream\nendobj\n`)
  objs.push('5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n')

  const head = '%PDF-1.4\n%\xFF\xFF\xFF\xFF\n'
  let buf = head
  const offsets: number[] = []
  for (const obj of objs) {
    offsets.push(Buffer.byteLength(buf, 'binary'))
    buf += obj
  }
  const xrefStart = Buffer.byteLength(buf, 'binary')
  buf += `xref\n0 ${objs.length + 1}\n`
  buf += '0000000000 65535 f \n'
  for (const o of offsets) {
    buf += String(o).padStart(10, '0') + ' 00000 n \n'
  }
  buf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`

  return Buffer.from(buf, 'binary')
}

describe('extractFromPdf — text layer', () => {
  it('extracts visible text from a tiny text-layer PDF', async () => {
    const pdf = makeTinyTextPdf('Hello World — slice 58C-FIX')
    const r = await extractFromPdf({ buffer: pdf, minTextLayerChars: 5 })
    expect(r.ocrText).toContain('Hello World')
    expect(r.evidence.source).toBe('pdfjs.text_layer')
    expect(r.evidence.pageCount).toBe(1)
  })

  it('returns sparse text without fallback when no vision creds', async () => {
    // Tiny PDF whose text layer is just 'X' — way below threshold.
    const pdf = makeTinyTextPdf('X')
    const r = await extractFromPdf({ buffer: pdf, minTextLayerChars: 100 })
    expect(r.evidence.reason).toBe('sparse_text_no_fallback')
    // No vision creds supplied → does NOT throw, just returns sparse text.
    expect(typeof r.ocrText).toBe('string')
  })
})
