// Slice 56N activity: import_traces.py wrapper + unreviewed-row counter.
//
// Both touch the DB directly (no need to shell out to Python) — they're
// pure SQL queries, easy to express in TS.

import { z } from 'zod';
import { getPool } from '../../../db/index.js';

// ── importTracesActivity ──────────────────────────────────────────────
//
// In v1 we INVOKE the existing Python import_traces.py via HTTP to the
// intent-classifier service rather than re-implementing the
// "fetch user text from Langfuse" step in TS. The intent-classifier
// service exposes a thin /admin/run-trace-import endpoint (added in
// the same slice 56N PR) that runs the script.
//
// Why an HTTP shim instead of kubectl-exec: workers don't have RBAC
// to exec into other pods. A POST to a cluster-internal service is
// the right pattern.

const ImportTracesInput = z.object({
  tenantId: z.string().uuid().nullable(),
  days:     z.number().int().min(1).max(90).default(7),
  limit:    z.number().int().min(1).max(5000).default(500),
});

const ImportTracesOutput = z.object({
  inserted: z.number(),
  skipped:  z.number(),
});

export async function importTracesActivity(
  input: z.input<typeof ImportTracesInput>,
): Promise<z.infer<typeof ImportTracesOutput>> {
  const args = ImportTracesInput.parse(input);

  const url = process.env['INTENT_CLASSIFIER_URL']
    ?? 'http://intent-classifier.cip-app.svc.cluster.local:8000';
  const resp = await fetch(`${url}/admin/run-trace-import`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tenant_id: args.tenantId,
      days:      args.days,
      limit:     args.limit,
    }),
  });
  if (!resp.ok) {
    throw new Error(`run-trace-import failed: ${resp.status} ${await resp.text()}`);
  }
  const body = (await resp.json()) as { inserted: number; skipped: number };
  return ImportTracesOutput.parse(body);
}

// ── countUnreviewedRowsActivity ───────────────────────────────────────

const CountUnreviewedInput = z.object({
  tenantId: z.string().uuid().nullable(),
});

const CountUnreviewedOutput = z.object({
  unreviewed:    z.number(),
  totalReviewed: z.number(),
});

export async function countUnreviewedRowsActivity(
  input: z.input<typeof CountUnreviewedInput>,
): Promise<z.infer<typeof CountUnreviewedOutput>> {
  const args = CountUnreviewedInput.parse(input);
  const pool = getPool();
  const params: unknown[] = [];
  let where = '';
  if (args.tenantId !== null) {
    where = ' WHERE tenant_id = $1 ';
    params.push(args.tenantId);
  }
  const r = await pool.query<{ unreviewed: string; total_reviewed: string }>(
    `SELECT
        COUNT(*) FILTER (WHERE NOT reviewed)::TEXT AS unreviewed,
        COUNT(*) FILTER (WHERE reviewed)::TEXT     AS total_reviewed
       FROM bot_intent_training_data ${where}`,
    params,
  );
  const row = r.rows[0]!;
  return CountUnreviewedOutput.parse({
    unreviewed:    parseInt(row.unreviewed,     10),
    totalReviewed: parseInt(row.total_reviewed, 10),
  });
}
