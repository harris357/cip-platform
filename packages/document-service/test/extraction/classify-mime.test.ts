// Slice 58C-FIX — classify-mime unit tests.

import { describe, it, expect } from 'vitest'
import { classifyMime } from '../../src/extraction/classify-mime.js'

describe('classifyMime — concrete MIMEs', () => {
  it('PDF MIME → pdf', () => {
    expect(classifyMime('application/pdf', 'doc.pdf')).toBe('pdf')
  })
  it('image/* MIME → image', () => {
    expect(classifyMime('image/png',  'pic.png')).toBe('image')
    expect(classifyMime('image/jpeg', 'pic.jpg')).toBe('image')
    expect(classifyMime('image/heic', 'pic.heic')).toBe('image')
  })
  it('text/* MIME → plain_text', () => {
    expect(classifyMime('text/plain',    'a.txt')).toBe('plain_text')
    expect(classifyMime('text/markdown', 'a.md')).toBe('plain_text')
    expect(classifyMime('text/csv',      'a.csv')).toBe('plain_text')
  })
  it('application/json + yaml → plain_text', () => {
    expect(classifyMime('application/json',   'a.json')).toBe('plain_text')
    expect(classifyMime('application/x-yaml', 'a.yaml')).toBe('plain_text')
  })
  it('OOXML MIMEs → docx/xlsx/pptx', () => {
    expect(classifyMime('application/vnd.openxmlformats-officedocument.wordprocessingml.document',  'a.docx')).toBe('docx')
    expect(classifyMime('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',         'a.xlsx')).toBe('xlsx')
    expect(classifyMime('application/vnd.openxmlformats-officedocument.presentationml.presentation', 'a.pptx')).toBe('pptx')
  })
  it('legacy office binaries → unsupported', () => {
    expect(classifyMime('application/msword',           'a.doc')).toBe('unsupported')
    expect(classifyMime('application/vnd.ms-excel',     'a.xls')).toBe('unsupported')
    expect(classifyMime('application/vnd.ms-powerpoint','a.ppt')).toBe('unsupported')
  })
})

describe('classifyMime — placeholder MIMEs fall back to extension', () => {
  it('octet-stream + .pdf extension → pdf', () => {
    expect(classifyMime('application/octet-stream', 'a.pdf')).toBe('pdf')
  })
  it('Teams synthetic MIME + .docx → docx', () => {
    expect(classifyMime('application/vnd.microsoft.teams.file.download.info', 'a.docx')).toBe('docx')
  })
  it('empty MIME + .png → image', () => {
    expect(classifyMime('', 'a.png')).toBe('image')
  })
  it('octet-stream + .txt → plain_text', () => {
    expect(classifyMime('application/octet-stream', 'a.txt')).toBe('plain_text')
  })
  it('octet-stream + .doc (legacy) → unsupported', () => {
    expect(classifyMime('application/octet-stream', 'a.doc')).toBe('unsupported')
  })
  it('octet-stream + unknown extension → unsupported', () => {
    expect(classifyMime('application/octet-stream', 'a.unknownext')).toBe('unsupported')
  })
})

describe('classifyMime — edge cases', () => {
  it('null mime + null filename → unsupported', () => {
    expect(classifyMime(null, null)).toBe('unsupported')
  })
  it('uppercase MIME normalises', () => {
    expect(classifyMime('APPLICATION/PDF', 'a.PDF')).toBe('pdf')
  })
  it('unknown concrete MIME but valid extension wins', () => {
    expect(classifyMime('application/zip', 'a.docx')).toBe('docx')
  })
})
