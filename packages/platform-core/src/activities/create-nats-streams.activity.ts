import { z } from 'zod';
import { StorageType, RetentionPolicy } from 'nats';
import { getNatsConnection, createJetStreamManager } from '@cip/shared';

const STREAM_CONFIGS = [
  { domain: 'hr',       maxAge: 365 * 24 * 60 * 60 * 1_000_000_000 },   // 1 year (ns)
  { domain: 'ops',      maxAge:  90 * 24 * 60 * 60 * 1_000_000_000 },
  { domain: 'platform', maxAge:  30 * 24 * 60 * 60 * 1_000_000_000 },
  { domain: 'agents',   maxAge:  30 * 24 * 60 * 60 * 1_000_000_000 },
] as const;

const OutputSchema = z.object({ streams: z.array(z.string()) });

export async function createNatsStreams(input: { tenantId: string }): Promise<void> {
  const nc = await getNatsConnection();
  const jsm = await createJetStreamManager(nc);
  const created: string[] = [];

  for (const cfg of STREAM_CONFIGS) {
    const name    = `cip-${input.tenantId}-${cfg.domain}`;
    const subject = `cip.${input.tenantId}.${cfg.domain}.>`;

    try {
      await jsm.streams.add({
        name,
        subjects:  [subject],
        storage:   StorageType.File,
        retention: RetentionPolicy.Limits,
        max_age:   cfg.maxAge,
      });
      created.push(name);
    } catch (err: unknown) {
      // Stream already exists — idempotent
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('stream name already in use') && !msg.includes('already exists')) {
        throw err;
      }
    }
  }

  OutputSchema.parse({ streams: created });
}
