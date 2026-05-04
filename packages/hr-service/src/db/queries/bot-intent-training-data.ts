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
  source:       'teach' | 'turn_label' | 'manual_csv' | 'trace_export';
  sourceTurnId?: string | null;
  notes?:       string | null;
}

export interface TrainingDataRow {
  id:             string;
  tenant_id:      string;
  added_by:       string;
  added_at:       Date;
  text:           string;
  intent:         string;
  tool:           string | null;
  next_action:    string;
  source:         string;
  source_turn_id: string | null;
  notes:          string | null;
  reviewed:       boolean;
}

export async function addTrainingData(
  pool: pg.Pool,
  input: AddTrainingDataInput,
): Promise<TrainingDataRow> {
  const r = await pool.query<TrainingDataRow>(
    `INSERT INTO bot_intent_training_data
       (tenant_id, added_by, text, intent, tool, next_action, source, source_turn_id, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      input.tenantId, input.addedBy, input.text, input.intent,
      input.tool ?? null, input.nextAction, input.source,
      input.sourceTurnId ?? null, input.notes ?? null,
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
 * Latest N model runs, newest first. Platform-wide (no tenant filter).
 * Used by the bot_intent_model_runs_list MCP tool and `make classifier-status`.
 */
export async function listModelRuns(
  pool: pg.Pool, limit = 20,
): Promise<ModelRunRow[]> {
  const r = await pool.query<ModelRunRow>(
    `SELECT * FROM bot_intent_model_runs
      ORDER BY trained_at DESC
      LIMIT $1`,
    [limit],
  );
  return r.rows;
}

/**
 * The single most recent model run, or null if none. Used to compute
 * "untrained rows since latest model" and to surface model_version in
 * /healthz cross-checks against the loaded artifact.
 */
export async function latestModelRun(
  pool: pg.Pool,
): Promise<ModelRunRow | null> {
  const r = await pool.query<ModelRunRow>(
    `SELECT * FROM bot_intent_model_runs
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
  const latest = await latestModelRun(pool);
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
  modelVersion:    string;
  corpusCutoffAt:  Date;
  trainCount:      number;
  intentsCount:    number;
  cvMacroF1:       number | null;
  holdoutMacroF1:  number | null;
  artifactUri:     string;
  artifactSha256:  string;
  trainerGitSha?:  string | null;
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
       (model_version, corpus_cutoff_at, train_count, intents_count,
        cv_macro_f1, holdout_macro_f1, artifact_uri, artifact_sha256,
        trainer_git_sha, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [
      input.modelVersion, input.corpusCutoffAt, input.trainCount, input.intentsCount,
      input.cvMacroF1, input.holdoutMacroF1, input.artifactUri, input.artifactSha256,
      input.trainerGitSha ?? null, input.notes ?? null,
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
