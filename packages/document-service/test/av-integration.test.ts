// Slice 58A — EICAR integration test against a real clamd.
//
// Skipped automatically if no clamd is reachable (CI dev environments
// without a clamav sidecar).  Pass CLAMAV_HOST / CLAMAV_PORT to point
// at the dev cluster's clamav service via port-forward, OR run
// inside the cluster.
//
//   $ kubectl port-forward -n cip-infra svc/clamav 3310:3310 &
//   $ CLAMAV_HOST=localhost CLAMAV_PORT=3310 pnpm --filter @cip/document-service test
//
// Tests are skip-by-default to keep `pnpm test` green on machines
// without a clamd handy.  Set CLAMAV_INTEGRATION=1 to run them.

import { describe, it, expect, beforeAll } from 'vitest'
import { ClamAVClient } from '../src/av/clamav-client.js'
import { eicarBuffer } from '../src/av/eicar-test.js'

const SHOULD_RUN = process.env['CLAMAV_INTEGRATION'] === '1'

describe.skipIf(!SHOULD_RUN)('clamav integration', () => {
  const client = new ClamAVClient()

  beforeAll(async () => {
    const ok = await client.ping()
    if (!ok) throw new Error('clamd unreachable — set CLAMAV_HOST/CLAMAV_PORT or kubectl port-forward')
  })

  it('detects the EICAR test pattern', async () => {
    const result = await client.scanBuffer(eicarBuffer())
    expect(result.clean).toBe(false)
    expect(result.threat ?? '').toMatch(/EICAR/i)
  })

  it('marks legitimate text as clean', async () => {
    const result = await client.scanBuffer(Buffer.from('hello world', 'utf-8'))
    expect(result.clean).toBe(true)
    expect(result.threat).toBeUndefined()
  })

  it('ping returns true', async () => {
    expect(await client.ping()).toBe(true)
  })
})
