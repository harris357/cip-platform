// Slice 58C — classify-document activity unit tests.
//
// Strategy: stub LiteLLM at the @cip/shared boundary, stub the DB, and
// exercise the activity's prompt-rendering, response-parsing, and
// fallback paths. We don't hit a live LLM here; the cluster smoke test
// covers the real LiteLLM round-trip.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockCallLLM = vi.fn()
const mockGetPrompt = vi.fn()
const mockPoolQuery = vi.fn()

vi.mock('@cip/shared', async () => {
  const actual = await vi.importActual<typeof import('@cip/shared')>('@cip/shared')
  return {
    ...actual,
    callLLM: (...args: unknown[]) => mockCallLLM(...args),
    createLiteLLMClient: () => ({}),
    getPrompt: (...args: unknown[]) => mockGetPrompt(...args),
  }
})

// In-memory documents row + audit_events list — replaces Drizzle for this test.
const stubRows: Array<Record<string, unknown>> = []
const auditRows: Array<Record<string, unknown>> = []

vi.mock('../src/db/index.js', () => ({
  getPool: () => ({ query: mockPoolQuery }),
  getDb:   () => ({
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({
      update: () => ({
        set: () => ({
          where: async () => { /* no-op for stub */ },
        }),
      }),
      insert: () => ({
        values: async (v: Record<string, unknown>) => { auditRows.push(v) },
      }),
    }),
  }),
}))

vi.mock('../src/db/rls.js', () => ({
  systemActorContext: () => ({}),
  withActorContext: async (_db: unknown, _actor: unknown, fn: (tx: unknown) => Promise<unknown>) => fn({
    update: () => ({
      set: (v: Record<string, unknown>) => ({
        where: async () => { stubRows.push(v) },
      }),
    }),
    insert: () => ({
      values: async (v: Record<string, unknown>) => { auditRows.push(v) },
    }),
  }),
}))

// eslint-disable-next-line import/first
import { classifyDocumentActivity } from '../src/modules/ingest/activities/classify-document.activity.js'

describe('classifyDocumentActivity', () => {
  const tenantId   = '11111111-1111-1111-1111-111111111111'
  const documentId = '22222222-2222-2222-2222-222222222222'

  beforeEach(() => {
    mockCallLLM.mockReset()
    mockGetPrompt.mockReset()
    mockPoolQuery.mockReset()
    stubRows.length  = 0
    auditRows.length = 0
    process.env['LITELLM_VIRTUAL_KEY'] = 'sk-test'
  })

  it('happy path: returns parsed (module, docType, confidence)', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [
      { module: 'certificate', doc_type: '*', notes: null },
    ]})
    mockGetPrompt.mockResolvedValueOnce({
      name: 'bot.documents.classify',
      version: 1,
      source: 'langfuse',
      compile: () => 'rendered prompt',
    })
    mockCallLLM.mockResolvedValueOnce({
      model: 'mistral-test',
      usage: { total_tokens: 42 },
      choices: [{ message: { content: JSON.stringify({
        module: 'certificate',
        doc_type: 'cpr',
        confidence: 0.91,
        alternatives: [{ module: 'certificate', docType: 'first_aid', confidence: 0.05 }],
        reasoning: 'CPR card matches',
      })}}],
    })

    const r = await classifyDocumentActivity({
      tenantId, documentId,
      ocrText: 'CPR Certification Holder John Smith',
      fileName: 'cpr.pdf',
      mimeType: 'application/pdf',
      sensitivityTier: 'internal',
      genericFeatures: { pageCount: 1 },
    })

    expect(r.module).toBe('certificate')
    expect(r.docType).toBe('cpr')
    expect(r.confidence).toBeCloseTo(0.91)
    expect(r.alternatives).toHaveLength(1)
    expect(r.evidence['promptSource']).toBe('langfuse')
    expect(r.evidence['modelUsed']).toBe('mistral-test')
    // Audit event recorded
    expect(auditRows.some(a => a['eventType'] === 'classified')).toBe(true)
  })

  it('falls back to FALLBACK_PROMPT when getPrompt throws', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] })
    mockGetPrompt.mockRejectedValueOnce(new Error('langfuse down'))
    mockCallLLM.mockResolvedValueOnce({
      model: 'mistral-test',
      usage: { total_tokens: 0 },
      choices: [{ message: { content: JSON.stringify({
        module: 'unknown', doc_type: 'unknown', confidence: 0.1,
        alternatives: [], reasoning: 'no catalog match',
      })}}],
    })

    const r = await classifyDocumentActivity({
      tenantId, documentId,
      ocrText: 'random pdf',
      fileName: 'a.pdf',
      mimeType: 'application/pdf',
      sensitivityTier: 'public',
      genericFeatures: {},
    })

    expect(r.evidence['promptSource']).toBe('fallback')
    expect(r.module).toBe('unknown')
  })

  it('returns "unknown/unknown" with confidence=0 when LiteLLM key missing', async () => {
    delete process.env['LITELLM_VIRTUAL_KEY']
    delete process.env['LITELLM_MASTER_KEY']

    const r = await classifyDocumentActivity({
      tenantId, documentId,
      ocrText: '',
      fileName: 'x.pdf',
      mimeType: 'application/pdf',
      sensitivityTier: 'public',
      genericFeatures: {},
    })

    expect(r.module).toBe('unknown')
    expect(r.confidence).toBe(0)
    expect(r.evidence['reasoning']).toBe('classify_skipped:no_litellm_key')
  })

  it('handles malformed LLM response by returning unknown/unknown', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] })
    mockGetPrompt.mockResolvedValueOnce({
      name: 'bot.documents.classify',
      version: 1,
      source: 'langfuse',
      compile: () => 'rendered',
    })
    mockCallLLM.mockResolvedValueOnce({
      model: 'mistral-test',
      usage: { total_tokens: 5 },
      choices: [{ message: { content: 'not json at all' }}],
    })

    const r = await classifyDocumentActivity({
      tenantId, documentId,
      ocrText: '',
      fileName: 'x.pdf',
      mimeType: 'application/pdf',
      sensitivityTier: 'public',
      genericFeatures: {},
    })

    expect(r.confidence).toBe(0)
    expect(r.evidence['reasoning']).toBe('classify_skipped:parse_error')
  })

  it('Zod-rejects out-of-range confidence and returns unknown', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] })
    mockGetPrompt.mockResolvedValueOnce({
      name: 'bot.documents.classify',
      version: 1,
      source: 'langfuse',
      compile: () => 'rendered',
    })
    mockCallLLM.mockResolvedValueOnce({
      model: 'mistral-test',
      usage: { total_tokens: 5 },
      choices: [{ message: { content: JSON.stringify({
        module: 'certificate', doc_type: 'cpr', confidence: 1.7,    // out of range
        alternatives: [], reasoning: 'borked',
      })}}],
    })

    const r = await classifyDocumentActivity({
      tenantId, documentId,
      ocrText: '',
      fileName: 'x.pdf',
      mimeType: 'application/pdf',
      sensitivityTier: 'public',
      genericFeatures: {},
    })

    expect(r.evidence['reasoning']).toBe('classify_skipped:parse_error')
  })
})
