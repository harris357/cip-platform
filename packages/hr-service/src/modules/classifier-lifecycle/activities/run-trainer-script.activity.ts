// Slice 56N activity: HTTP shims to the intent-classifier service's
// /admin endpoints that wrap the existing Python scripts (export, train,
// eval). Keeps the Python code as the single source of truth.
//
// All three endpoints are added to the intent-classifier service in the
// same slice 56N PR. They run synchronously on the classifier pod;
// Temporal's startToCloseTimeout protects us from hung calls.

import { z } from 'zod';

const classifierUrl = (): string =>
  process.env['INTENT_CLASSIFIER_URL']
    ?? 'http://intent-classifier.cip-app.svc.cluster.local:8000';

// ── exportTrainingDataActivity ────────────────────────────────────────

const ExportTrainingDataInput  = z.object({ tenantId: z.string().uuid().nullable() });
const ExportTrainingDataOutput = z.object({ csvPath: z.string(), rowCount: z.number() });

export async function exportTrainingDataActivity(
  input: z.input<typeof ExportTrainingDataInput>,
): Promise<z.infer<typeof ExportTrainingDataOutput>> {
  const args = ExportTrainingDataInput.parse(input);
  const resp = await fetch(`${classifierUrl()}/admin/run-export`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ tenant_id: args.tenantId }),
  });
  if (!resp.ok) {
    throw new Error(`run-export failed: ${resp.status} ${await resp.text()}`);
  }
  return ExportTrainingDataOutput.parse(await resp.json());
}

// ── trainModelActivity ────────────────────────────────────────────────

const TrainModelInput = z.object({
  tenantId: z.string().uuid().nullable(),
  csvPath:  z.string(),
  version:  z.string(),
});
const TrainModelOutput = z.object({
  artifactPath:   z.string(),
  version:        z.string(),
  cvMacroF1:      z.number().nullable(),
  intentsCount:   z.number(),
  corpusCutoffAt: z.string(),  // ISO timestamp; activity layer keeps it as string
});

export async function trainModelActivity(
  input: z.input<typeof TrainModelInput>,
): Promise<z.infer<typeof TrainModelOutput>> {
  const args = TrainModelInput.parse(input);
  const resp = await fetch(`${classifierUrl()}/admin/run-train`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      tenant_id: args.tenantId,
      csv_path:  args.csvPath,
      version:   args.version,
    }),
  });
  if (!resp.ok) {
    throw new Error(`run-train failed: ${resp.status} ${await resp.text()}`);
  }
  return TrainModelOutput.parse(await resp.json());
}

// ── evalModelActivity ─────────────────────────────────────────────────

const EvalModelInput = z.object({
  tenantId:        z.string().uuid().nullable(),
  csvPath:         z.string(),
  candidatePath:   z.string(),
  minImprovement:  z.number(),
  maxRegression:   z.number(),
});
const EvalModelOutput = z.object({
  passed:        z.boolean(),
  candidateF1:   z.number(),
  baselineF1:    z.number().nullable(),
  reason:        z.string().nullable(),
});

export async function evalModelActivity(
  input: z.input<typeof EvalModelInput>,
): Promise<z.infer<typeof EvalModelOutput>> {
  const args = EvalModelInput.parse(input);
  const resp = await fetch(`${classifierUrl()}/admin/run-eval`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      tenant_id:       args.tenantId,
      csv_path:        args.csvPath,
      candidate_path:  args.candidatePath,
      min_improvement: args.minImprovement,
      max_regression:  args.maxRegression,
    }),
  });
  if (!resp.ok) {
    throw new Error(`run-eval failed: ${resp.status} ${await resp.text()}`);
  }
  return EvalModelOutput.parse(await resp.json());
}
