// Slice 56N activities: bot_intent_model_runs + bot_intent_training_membership
// INSERTs as Temporal activities so they're independently retriable +
// the workflow can compensate-delete on partial failure.

import { z } from 'zod';
import { getPool } from '../../../db/index.js';
import {
  addModelRun,
} from '../../../db/queries/bot-intent-training-data.js';

// ── recordModelRunActivity ────────────────────────────────────────────

const RecordModelRunInput = z.object({
  tenantId:        z.string().uuid().nullable(),
  modelVersion:    z.string(),
  corpusCutoffAt:  z.string(),
  trainCount:      z.number().int().nonnegative(),
  intentsCount:    z.number().int().nonnegative(),
  cvMacroF1:       z.number().nullable(),
  holdoutMacroF1:  z.number().nullable(),
  artifactUri:     z.string(),
  artifactSha256:  z.string(),
  workflowId:      z.string(),  // Slice 56N: cross-reference into Temporal
  notes:           z.string().nullable(),
});
const RecordModelRunOutput = z.object({ id: z.string() });

export async function recordModelRunActivity(
  input: z.input<typeof RecordModelRunInput>,
): Promise<z.infer<typeof RecordModelRunOutput>> {
  const args = RecordModelRunInput.parse(input);
  const row = await addModelRun(getPool(), {
    tenantId:        args.tenantId,
    modelVersion:    args.modelVersion,
    corpusCutoffAt:  new Date(args.corpusCutoffAt),
    trainCount:      args.trainCount,
    intentsCount:    args.intentsCount,
    cvMacroF1:       args.cvMacroF1,
    holdoutMacroF1:  args.holdoutMacroF1,
    artifactUri:     args.artifactUri,
    artifactSha256:  args.artifactSha256,
    workflowId:      args.workflowId,
    notes:           args.notes,
  });
  return RecordModelRunOutput.parse({ id: row.id });
}

// ── recordTrainingMembershipActivity ──────────────────────────────────

const RecordMembershipInput = z.object({
  modelRunId:     z.string().uuid(),
  corpusCutoffAt: z.string(),
  tenantId:       z.string().uuid().nullable(),
});
const RecordMembershipOutput = z.object({ rowsRecorded: z.number() });

export async function recordTrainingMembershipActivity(
  input: z.input<typeof RecordMembershipInput>,
): Promise<z.infer<typeof RecordMembershipOutput>> {
  const args = RecordMembershipInput.parse(input);
  const pool = getPool();
  // Slice 56D: filter by tenant_id when set (per-tenant model membership);
  // platform-wide model gets all tenants' eligible rows.
  const sql = args.tenantId !== null
    ? `INSERT INTO bot_intent_training_membership (model_run_id, training_data_id)
        SELECT $1, td.id
          FROM bot_intent_training_data td
         WHERE td.reviewed = true
           AND td.added_at <= $2
           AND td.tenant_id = $3
        ON CONFLICT DO NOTHING`
    : `INSERT INTO bot_intent_training_membership (model_run_id, training_data_id)
        SELECT $1, td.id
          FROM bot_intent_training_data td
         WHERE td.reviewed = true
           AND td.added_at <= $2
        ON CONFLICT DO NOTHING`;
  const params = args.tenantId !== null
    ? [args.modelRunId, new Date(args.corpusCutoffAt), args.tenantId]
    : [args.modelRunId, new Date(args.corpusCutoffAt)];
  const r = await pool.query(sql, params);
  return RecordMembershipOutput.parse({ rowsRecorded: r.rowCount ?? 0 });
}
