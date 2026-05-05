// Slice 58C — registry resolveStrategy() unit tests.
//
// We mock the pool to return the candidate-row set the SQL would
// produce; the test verifies the in-memory specificity scoring picks
// the right row across all four fallback tiers.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const ZERO_UUID = '00000000-0000-0000-0000-000000000000'
const TENANT_A  = '11111111-1111-1111-1111-111111111111'

// Stub the pool BEFORE importing registry (resolveStrategy reads getPool()).
const mockQuery = vi.fn()
vi.mock('../src/db/index.js', () => ({
  getPool: () => ({ query: mockQuery }),
  getDb:   () => { throw new Error('getDb not used in registry tests') },
}))

// eslint-disable-next-line import/first
import { resolveStrategy } from '../src/extraction/registry.js'

interface Row {
  tenant_id:     string
  module:        string
  doc_type:      string
  strategy_name: string
  task_queue:    string
  activity_name: string
  config_json:   Record<string, unknown> | null
  enabled:       boolean
  mime_filter:   string | null
}

function row(over: Partial<Row>): Row {
  return {
    tenant_id:     ZERO_UUID,
    module:        'certificate',
    doc_type:      '*',
    strategy_name: 'extract_certificate_default',
    task_queue:    'cip-hr-tasks',
    activity_name: 'extractCertFeaturesActivity',
    config_json:   {},
    enabled:       true,
    mime_filter:   null,
    ...over,
  }
}

describe('resolveStrategy fallback ordering', () => {
  beforeEach(() => mockQuery.mockReset())

  it('prefers exact (tenant, module, doc_type) over zero-UUID catchall', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [
      row({ tenant_id: TENANT_A, doc_type: 'cpr', strategy_name: 'tenant-cpr' }),
      row({}),
    ]})
    const r = await resolveStrategy(TENANT_A, 'certificate', 'cpr')
    expect(r?.strategyName).toBe('tenant-cpr')
    expect(r?.tenantId).toBe(TENANT_A)
    expect(r?.docType).toBe('cpr')
  })

  it('prefers tenant wildcard over zero-UUID exact', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [
      row({ tenant_id: TENANT_A, doc_type: '*',   strategy_name: 'tenant-wild' }),
      row({ tenant_id: ZERO_UUID, doc_type: 'cpr', strategy_name: 'global-cpr' }),
    ]})
    const r = await resolveStrategy(TENANT_A, 'certificate', 'cpr')
    expect(r?.strategyName).toBe('tenant-wild')
  })

  it('falls through to zero-UUID exact when tenant has no row', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [
      row({ tenant_id: ZERO_UUID, doc_type: 'cpr', strategy_name: 'global-cpr' }),
      row({ tenant_id: ZERO_UUID, doc_type: '*',   strategy_name: 'global-wild' }),
    ]})
    const r = await resolveStrategy(TENANT_A, 'certificate', 'cpr')
    expect(r?.strategyName).toBe('global-cpr')
  })

  it('falls through to zero-UUID wildcard when nothing else matches', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [
      row({ tenant_id: ZERO_UUID, doc_type: '*', strategy_name: 'global-wild' }),
    ]})
    const r = await resolveStrategy(TENANT_A, 'certificate', 'cpr')
    expect(r?.strategyName).toBe('global-wild')
    expect(r?.docType).toBe('*')
  })

  it('returns null when no enabled strategy matches', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [
      row({ tenant_id: ZERO_UUID, doc_type: '*', enabled: false }),
    ]})
    const r = await resolveStrategy(TENANT_A, 'certificate', 'cpr')
    expect(r).toBeNull()
  })

  it('skips disabled rows even when they would otherwise win', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [
      row({ tenant_id: TENANT_A, doc_type: 'cpr', strategy_name: 'disabled', enabled: false }),
      row({ tenant_id: ZERO_UUID, doc_type: '*',  strategy_name: 'global-wild' }),
    ]})
    const r = await resolveStrategy(TENANT_A, 'certificate', 'cpr')
    expect(r?.strategyName).toBe('global-wild')
  })

  it('returns the config_json verbatim (defaults to {} on null)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [
      row({ tenant_id: TENANT_A, doc_type: 'cpr', config_json: { taskTimeoutMs: 30000 } }),
    ]})
    const r = await resolveStrategy(TENANT_A, 'certificate', 'cpr')
    expect(r?.configJson).toEqual({ taskTimeoutMs: 30000 })

    mockQuery.mockResolvedValueOnce({ rows: [
      row({ tenant_id: TENANT_A, doc_type: 'cpr', config_json: null }),
    ]})
    const r2 = await resolveStrategy(TENANT_A, 'certificate', 'cpr')
    expect(r2?.configJson).toEqual({})
  })
})
