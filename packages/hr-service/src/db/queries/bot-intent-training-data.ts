// Slice 56B: queries for bot_intent_training_data + model lifecycle.
//
// Two concerns in one module since they share lineage:
//   1. The labeled training rows (text, intent, tool, next_action…) —
//      tenant-scoped; sourced from /teach, turn-label, manual_csv,
//      and (Slice 56e) Langfuse trace exports.
//   2. The model runs that consumed them — platform-wide; one row per
//      `make classifier-train` invocation that produced an artifact.
//
// Renamed from bot-intent-examples.ts in Slice 56B alongside the table
// rename (bot_intent_examples → bot_intent_training_data). Old name was
// from a bootstrap-flavoured era; rows are training data, not examples.

import type pg from 'pg';

// ───────────────────────────────────────────────────────────────────
// Training-data rows (tenant-scoped)
// ───────────────────────────────────────────────────────────────────

export interface AddTrainingDataInput {
  tenantId:     string;
  addedBy:      string;
  text:         string;
  intent:       string;
  tool?:        string | null;
  nextAction:   'call_tool' | 'clarify' | 'answer_directly' | 'unknown';
  source:       'teach' | 'turn_label' | 'manual_csv' | 'trace_export'
              | 'verdict_positive' | 'confusion_correction';
  sourceTurnId?: string | null;
  /** Slice 56E: Langfuse trace UUID (separate from sourceTurnId, which
   *  holds the bot's 8-char hex turnId). Set by import_traces.py. */
  sourceLangfuseTraceId?: string | null;
  /** Slice 56L: the ORIGINAL predicted intent/tool from the source turn.
   *  Preserved so an admin relabel of `intent` doesn't destroy the
   *  confusion-matrix signal. For non-correction sources (manual_csv,
   *  teach, verdict_positive, trace_export-tier-1/2), predicted_intent
   *  matches `intent` (no confusion). For confusion_correction rows it
   *  carries the classifier's wrong guess. */
  predictedIntent?: string | null;
  predictedTool?:   string | null;
  notes?:       string | null;
}

export interface TrainingDataRow {
  id:                       string;
  tenant_id:                string;
  added_by:                 string;
  added_at:                 Date;
  text:                     string;
  intent:                   string;
  tool:                     string | null;
  next_action:              string;
  source:                   string;
  source_turn_id:           string | null;
  /** Slice 56E: populated only when source='trace_export'. */
  source_langfuse_trace_id: string | null;
  /** Slice 56L: original prediction from the source turn. Survives admin
   *  relabel of `intent`, so confusion-matrix queries stay intact. */
  predicted_intent:         string | null;
  predicted_tool:           string | null;
  notes:                    string | null;
  reviewed:                 boolean;
}

export async function addTrainingData(
  pool: pg.Pool,
  input: AddTrainingDataInput,
): Promise<TrainingDataRow> {
  // Slice 56L: default predicted_intent/predicted_tool to the inserted
  // intent/tool when the caller doesn't override. Only confusion_correction
  // imports pass a different value (the classifier's original wrong guess).
  const predictedIntent = input.predictedIntent ?? input.intent;
  const predictedTool   = input.predictedTool   ?? input.tool ?? null;
  const r = await pool.query<TrainingDataRow>(
    `INSERT INTO bot_intent_training_data
       (tenant_id, added_by, text, intent, tool, next_action, source,
        source_turn_id, source_langfuse_trace_id,
        predicted_intent, predicted_tool, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING *`,
    [
      input.tenantId, input.addedBy, input.text, input.intent,
      input.tool ?? null, input.nextAction, input.source,
      input.sourceTurnId ?? null, input.sourceLangfuseTraceId ?? null,
      predictedIntent, predictedTool,
      input.notes ?? null,
    ],
  );
  return r.rows[0]!;
}

export async function listUnreviewed(
  pool: pg.Pool, tenantId: string, limit = 50,
): Promise<TrainingDataRow[]> {
  const r = await pool.query<TrainingDataRow>(
    `SELECT * FROM bot_intent_training_data
      WHERE tenant_id = $1 AND NOT reviewed
      ORDER BY added_at DESC
      LIMIT $2`,
    [tenantId, limit],
  );
  return r.rows;
}

export async function markReviewed(
  pool: pg.Pool, tenantId: string, ids: string[],
): Promise<number> {
  const r = await pool.query(
    `UPDATE bot_intent_training_data
       SET reviewed = true
     WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
    [tenantId, ids],
  );
  return r.rowCount ?? 0;
}

// ───────────────────────────────────────────────────────────────────
// Model runs (platform-wide)
// ───────────────────────────────────────────────────────────────────

export interface ModelRunRow {
  id:                string;
  /** Slice 56D: NULL = platform-wide model; UUID = tenant-specific. */
  tenant_id:         string | null;
  model_version:     string;
  trained_at:        Date;
  corpus_cutoff_at:  Date;
  train_count:       number;
  intents_count:     number;
  cv_macro_f1:       number | null;
  holdout_macro_f1:  number | null;
  artifact_uri:      string;
  artifact_sha256:   string;
  trainer_git_sha:   string | null;
  deployed_at:       Date | null;
  deprecated_at:     Date | null;
  notes:             string | null;
}

/**
 * Latest N model runs, newest first.
 *
 * Slice 56D: tenantId filter:
 *   - undefined → all rows (platform + per-tenant)
 *   - null      → only platform-wide rows
 *   - UUID      → only that tenant's rows
 */
export async function listModelRuns(
  pool: pg.Pool, limit = 20, tenantId?: string | null,
): Promise<ModelRunRow[]> {
  if (tenantId === undefined) {
    const r = await pool.query<ModelRunRow>(
      `SELECT * FROM bot_intent_model_runs
        ORDER BY trained_at DESC
        LIMIT $1`,
      [limit],
    );
    return r.rows;
  }
  if (tenantId === null) {
    const r = await pool.query<ModelRunRow>(
      `SELECT * FROM bot_intent_model_runs
        WHERE tenant_id IS NULL
        ORDER BY trained_at DESC
        LIMIT $1`,
      [limit],
    );
    return r.rows;
  }
  const r = await pool.query<ModelRunRow>(
    `SELECT * FROM bot_intent_model_runs
      WHERE tenant_id = $1
      ORDER BY trained_at DESC
      LIMIT $2`,
    [tenantId, limit],
  );
  return r.rows;
}

/**
 * The single most recent model run for a given scope, or null if none.
 *
 * Slice 56D: tenantId selects platform vs tenant-specific:
 *   - undefined or null → platform-wide latest (tenant_id IS NULL)
 *   - UUID              → that tenant's latest
 */
export async function latestModelRun(
  pool: pg.Pool, tenantId?: string | null,
): Promise<ModelRunRow | null> {
  if (tenantId) {
    const r = await pool.query<ModelRunRow>(
      `SELECT * FROM bot_intent_model_runs
        WHERE tenant_id = $1
        ORDER BY trained_at DESC
        LIMIT 1`,
      [tenantId],
    );
    return r.rows[0] ?? null;
  }
  const r = await pool.query<ModelRunRow>(
    `SELECT * FROM bot_intent_model_runs
      WHERE tenant_id IS NULL
      ORDER BY trained_at DESC
      LIMIT 1`,
  );
  return r.rows[0] ?? null;
}

/**
 * Count of training rows added since the latest model's corpus_cutoff_at.
 * Cheap because we don't UPDATE rows on train — the cutoff timestamp on
 * the model_run row + an indexed scan on training_data.added_at gives
 * an O(N) answer where N is the new-row count, not total rows.
 *
 * Cross-tenant by default (the model is platform-wide); pass tenantId
 * for the per-tenant count.
 */
export async function countUntrainedSinceLatest(
  pool: pg.Pool, tenantId?: string,
): Promise<{ untrained: number; latestModelVersion: string | null; corpusCutoffAt: Date | null }> {
  // Slice 56D: when tenantId is provided, compare against that tenant's
  // latest model. Otherwise compare against the platform-wide latest.
  const latest = await latestModelRun(pool, tenantId ?? null);
  if (!latest) {
    // No model yet — every reviewed row counts as untrained.
    const r = await pool.query<{ c: string }>(
      tenantId
        ? `SELECT COUNT(*)::TEXT AS c FROM bot_intent_training_data
            WHERE reviewed = true AND tenant_id = $1`
        : `SELECT COUNT(*)::TEXT AS c FROM bot_intent_training_data
            WHERE reviewed = true`,
      tenantId ? [tenantId] : [],
    );
    return {
      untrained:          parseInt(r.rows[0]?.c ?? '0', 10),
      latestModelVersion: null,
      corpusCutoffAt:     null,
    };
  }
  const r = await pool.query<{ c: string }>(
    tenantId
      ? `SELECT COUNT(*)::TEXT AS c FROM bot_intent_training_data
          WHERE reviewed = true AND added_at > $1 AND tenant_id = $2`
      : `SELECT COUNT(*)::TEXT AS c FROM bot_intent_training_data
          WHERE reviewed = true AND added_at > $1`,
    tenantId ? [latest.corpus_cutoff_at, tenantId] : [latest.corpus_cutoff_at],
  );
  return {
    untrained:          parseInt(r.rows[0]?.c ?? '0', 10),
    latestModelVersion: latest.model_version,
    corpusCutoffAt:     latest.corpus_cutoff_at,
  };
}

export interface AddModelRunInput {
  /** Slice 56D: null (or omitted) = platform-wide; UUID = tenant-specific. */
  tenantId?:       string | null;
  modelVersion:    string;
  corpusCutoffAt:  Date;
  trainCount:      number;
  intentsCount:    number;
  cvMacroF1:       number | null;
  holdoutMacroF1:  number | null;
  artifactUri:     string;
  artifactSha256:  string;
  trainerGitSha?:  string | null;
  /** Slice 56N: Temporal workflow id that produced this model run.
   *  Lets ops correlate "DB-recorded model" with "Temporal workflow that
   *  produced it". NULL for cron-script-driven runs (slice 56C-style)
   *  to maintain back-compat. */
  workflowId?:     string | null;
  notes?:          string | null;
}

/**
 * Insert a new model run row. Called by the trainer after a successful
 * fit + S3 upload. Use the returned id to populate
 * bot_intent_training_membership for the rows that fed the run.
 */
export async function addModelRun(
  pool: pg.Pool, input: AddModelRunInput,
): Promise<ModelRunRow> {
  const r = await pool.query<ModelRunRow>(
    `INSERT INTO bot_intent_model_runs
       (tenant_id, model_version, corpus_cutoff_at, train_count, intents_count,
        cv_macro_f1, holdout_macro_f1, artifact_uri, artifact_sha256,
        trainer_git_sha, workflow_id, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING *`,
    [
      input.tenantId ?? null, input.modelVersion, input.corpusCutoffAt,
      input.trainCount, input.intentsCount, input.cvMacroF1, input.holdoutMacroF1,
      input.artifactUri, input.artifactSha256,
      input.trainerGitSha ?? null,
      input.workflowId ?? null,
      input.notes ?? null,
    ],
  );
  return r.rows[0]!;
}

/**
 * Mark a model run as deployed (classifier loaded the artifact). Called
 * by the operator after `make classifier-status` confirms the swap, or
 * (future) by the classifier itself on hot-load.
 */
export async function markModelDeployed(
  pool: pg.Pool, modelVersion: string,
): Promise<number> {
  const r = await pool.query(
    `UPDATE bot_intent_model_runs
       SET deployed_at = NOW()
     WHERE model_version = $1 AND deployed_at IS NULL`,
    [modelVersion],
  );
  return r.rowCount ?? 0;
}
