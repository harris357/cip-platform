// Slice 58C-FIX — PPTX text extraction.
//
// We author a minimal PPTX inline via JSZip — only enough OOXML for
// our extractor's regex walk to find <a:t> text runs. We don't include
// theme/master slides; the extractor doesn't use them.

import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'

import { extractFromPptx } from '../../src/extraction/extract-from-pptx.js'

async function makeTinyPptx(slides: string[][]): Promise<Buffer> {
  const zip = new JSZip()

  zip.file('[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml"  ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  ${slides.map((_, i) =>
    `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`,
  ).join('\n  ')}
</Types>`)

  zip.file('_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`)

  zip.file('ppt/presentation.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>`)

  slides.forEach((runs, idx) => {
    const i = idx + 1
    const xml =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
       xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld>
    <p:spTree>
      ${runs.map(r => `<a:t>${escapeXml(r)}</a:t>`).join('\n      ')}
    </p:spTree>
  </p:cSld>
</p:sld>`
    zip.file(`ppt/slides/slide${i}.xml`, xml)
  })

  return await zip.generateAsync({ type: 'nodebuffer' })
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

describe('extractFromPptx', () => {
  it('extracts text runs across multiple slides in order', async () => {
    const buf = await makeTinyPptx([
      ['Title: Q4 Compliance', 'Acme Training Co.'],
      ['CPR coverage at 87%', 'Action: chase 12 expirations'],
      ['Q&A — open floor'],
    ])
    const r = await extractFromPptx(buf)
    expect(r.ocrText).toContain('--- SLIDE 1 ---')
    expect(r.ocrText).toContain('Title: Q4 Compliance')
    expect(r.ocrText).toContain('Acme Training Co.')
    expect(r.ocrText).toContain('--- SLIDE 2 ---')
    expect(r.ocrText).toContain('CPR coverage at 87%')
    expect(r.ocrText).toContain('--- SLIDE 3 ---')
    expect(r.ocrText).toContain('Q&A — open floor')
    expect(r.evidence.source).toBe('pptx.slide_xml')
    expect(r.evidence.slideCount).toBe(3)
  })

  it('decodes XML entities in text runs', async () => {
    const buf = await makeTinyPptx([['Tom & Jerry <2024>']])
    const r = await extractFromPptx(buf)
    expect(r.ocrText).toContain('Tom & Jerry <2024>')
  })
})
