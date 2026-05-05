// Slice 58C-FIX — DOCX extraction.
//
// We author a tiny DOCX inline using the OOXML zip layout — this avoids
// committing binary fixtures while still exercising mammoth's parsing.

import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'

import { extractFromDocx } from '../../src/extraction/extract-from-docx.js'

async function makeTinyDocx(paragraphs: string[]): Promise<Buffer> {
  const zip = new JSZip()

  zip.file('[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml"  ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`)

  zip.file('_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`)

  const body = paragraphs.map(p =>
    `<w:p><w:r><w:t xml:space="preserve">${escapeXml(p)}</w:t></w:r></w:p>`,
  ).join('')

  zip.file('word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${body}</w:body>
</w:document>`)

  return await zip.generateAsync({ type: 'nodebuffer' })
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

describe('extractFromDocx', () => {
  it('extracts paragraph text from a tiny .docx', async () => {
    const buf = await makeTinyDocx([
      'CPR Certification — Acme Training Co.',
      'Holder: David Lee',
      'Issue date: 2024-03-15',
    ])
    const r = await extractFromDocx(buf)
    expect(r.ocrText).toContain('CPR Certification')
    expect(r.ocrText).toContain('David Lee')
    expect(r.ocrText).toContain('2024-03-15')
    expect(r.evidence.source).toBe('mammoth.extractRawText')
  })

  it('handles empty docx body', async () => {
    const buf = await makeTinyDocx([])
    const r = await extractFromDocx(buf)
    expect(r.ocrText).toBe('')
  })
})
