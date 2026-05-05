// Slice 58A — thin clamd INSTREAM client wrapper.
//
// Wraps the `clamscan` npm package (marked Inactive but still
// functional; budget for fork-or-replace if a CVE lands; pinned to
// 2.4.0).  Single class, single method `scanBuffer`, exposes the
// minimum surface 58B's scan activity needs.
//
// Connection settings come from env: CLAMAV_HOST + CLAMAV_PORT.
// Defaults match the helm chart layout (clamav.cip-infra.svc.cluster.local:3310).

import type { default as Clam } from 'clamscan'

export interface ScanResult {
  clean: boolean
  threat?: string                         // e.g. 'Win.Test.EICAR_HDB-1' on detection
  signatureDbAgeSeconds?: number          // 58B persists onto documents.av_signature_db_age_seconds
  rawOutput?: string
}

export interface ClamAVClientConfig {
  host?:    string
  port?:    number
  /** ms; 60s is generous — most scans complete in <2s */
  timeout?: number
}

/**
 * Lazy-initialised so test environments without a clamd reachable
 * don't blow up at module load.  Initialisation is async (clamscan
 * pings clamd on init).
 */
let _scanner: Clam | null = null

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LooseClam = any   // clamscan's type defs are loose around init() return + scanStream — typed shape varies by version

async function init(cfg: ClamAVClientConfig): Promise<Clam> {
  if (_scanner) return _scanner
  // Dynamic import to dodge the heavyweight init sync and tolerate
  // environments where clamscan isn't installed (test mocks).
  const NodeClam = (await import('clamscan')).default as unknown as new (...args: unknown[]) => LooseClam
  const instance = new NodeClam()
  _scanner = await (instance as LooseClam).init({
    debug_mode: false,
    clamdscan: {
      host: cfg.host ?? process.env['CLAMAV_HOST'] ?? 'clamav.cip-infra.svc.cluster.local',
      port: cfg.port ?? Number(process.env['CLAMAV_PORT'] ?? 3310),
      timeout: cfg.timeout ?? 60_000,
      local_fallback: false,
      socket: false,
    },
    preference: 'clamdscan',
  })
  return _scanner!
}

export class ClamAVClient {
  constructor(private readonly cfg: ClamAVClientConfig = {}) {}

  /**
   * Scan a Buffer via INSTREAM.  Streams bytes to clamd; never
   * touches local disk.  Returns clean=false + threat name on hit;
   * throws on connection error (Temporal activity will retry).
   */
  async scanBuffer(buffer: Buffer): Promise<ScanResult> {
    const scanner = await init(this.cfg) as LooseClam
    const { Readable } = await import('node:stream')
    const stream = Readable.from(buffer)
    const { isInfected, viruses } = await scanner.scanStream(stream)
    if (isInfected) {
      return {
        clean: false,
        threat: Array.isArray(viruses) ? (viruses[0] ?? 'unknown') : String(viruses ?? 'unknown'),
      }
    }
    return { clean: true }
  }

  /** Liveness check — sends PING, expects PONG. */
  async ping(): Promise<boolean> {
    try {
      const scanner = await init(this.cfg) as LooseClam
      await scanner.ping()
      return true
    } catch {
      return false
    }
  }
}
