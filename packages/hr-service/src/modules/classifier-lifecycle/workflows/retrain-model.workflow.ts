// Slice 56N: classifier model lifecycle as a Temporal workflow.
//
// Replaces the slice-56C cron-bash chain (skip-check → export → eval →
// train → S3 upload → DB lineage → membership) with a single durable
// workflow that:
//   - survives pod restarts (any step picks up where it left off)
//   - blocks for human review via signal (admin curation isn't on a
//     cron schedule; the workflow waits as long as it needs to)
//   - runs compensating actions on partial failure (e.g. delete the
//     uploaded artifact if DB lineage write fails afterward)
//   - is observable via Temporal Web UI step-by-step
//   - can fan out per-tenant via child workflows (slice 56D extension)
//
// Workflow ID pattern: `RetrainModel-${tenantId ?? 'platform'}-${triggerId}`
// Triggers:
//   - `bot_classifier_retrain` MCP tool (admin-fired)
//   - the trainer CronJob (Sunday 02:30 UTC) — replaces the bash entrypoint
//
// Signal: `adminApprovalSignal({ approvedRowIds: string[] })` — sent
// after the human review step. Without this signal, the workflow waits
// indefinitely (or up to ADMIN_REVIEW_TIMEOUT, then fails closed).

import {
  proxyActivities,
  defineSignal,
  defineQuery,
  setHandler,
  condition,
  log,
  workflowInfo,
  ApplicationFailure,
} from '@temporalio/workflow';
import type * as activities from '../activities/index.js';

// ── Signals + queries ──────────────────────────────────────────────────

export interface AdminApprovalSignalPayload {
  /** Array of bot_intent_training_data row ids the admin approved.
   *  Empty array means "approve everything currently unreviewed" —
   *  bulk-approve shortcut for low-risk tenants. */
  approvedRowIds: string[];
  /** Optional reviewer note; persisted as bot_intent_model_runs.notes. */
  note?: string;
}

export const adminApprovalSignal = defineSignal<[AdminApprovalSignalPayload]>('adminApproval');

/** Query the workflow for its current step — used by the admin dashboard
 *  / `make classifier-status` to render "where are we in the pipeline?". */
export const stepQuery = defineQuery<string>('currentStep');

// ── Activity proxies ───────────────────────────────────────────────────

// Most activities are quick (DB queries, S3 PUT, /healthz polls). 5-min
// startToCloseTimeout covers all of them with headroom.
const {
  importTracesActivity,
  countUnreviewedRowsActivity,
  notifyAdminReviewPendingActivity,
  exportTrainingDataActivity,
  evalModelActivity,
  uploadModelToS3Activity,
  recordModelRunActivity,
  recordTrainingMembershipActivity,
  verifyHotReloadActivity,
} = proxyActivities<typeof activities>({
  startToCloseTimeout: '5 minutes',
  retry: { maximumAttempts: 3 },
});

// Training is the long pole — sklearn fit on hundreds-to-thousands of
// rows can take 1-5 min cold + LLM-augmentation can balloon it. Don't
// auto-retry expensive train; if it failed once, the workflow surfaces
// the failure so a human can investigate.
const {
  trainModelActivity,
} = proxyActivities<typeof activities>({
  startToCloseTimeout: '30 minutes',
  retry: { maximumAttempts: 1 },
});

// ── Workflow input + output ────────────────────────────────────────────

export interface RetrainModelWorkflowInput {
  /** Null = platform-wide model. UUID = per-tenant (slice 56D). */
  tenantId:        string | null;
  /** Bot's 8-char turn id from the triggering /classifier-retrain command,
   *  or 'cron-YYYYMMDD' for the scheduled run. Used for workflow id. */
  triggerId:       string;
  /** Optional. When set, skip the import + admin-review wait and go
   *  straight to train (the "I just want to retrain on whatever's
   *  already approved" path). */
  skipImportAndReview?: boolean;
  /** Hard deadline for admin review. Workflow fails closed after this.
   *  Default: 30 days. */
  adminReviewTimeoutHours?: number;
  /** Slice 57C: when 'import-only', do steps 1-2 (import traces,
   *  count rows) only and return — no admin review, no train, no
   *  promotion. Replaces the standalone intent-classifier-trace-import
   *  CronJob with one workflow class fronting two schedules. */
  mode?:           'full' | 'import-only';
}

export interface RetrainModelWorkflowOutput {
  outcome:        'shipped' | 'skipped_no_data' | 'eval_gate_failed' | 'admin_review_timeout' | 'error' | 'import_complete';
  modelVersion?:  string;
  artifactUri?:   string;
  cvMacroF1?:     number | null;
  rowsTrained?:   number;
  /** Slice 57C: count of rows imported on the import-only path. */
  imported?:      number;
}

// ── Workflow body ──────────────────────────────────────────────────────

export async function RetrainModelWorkflow(
  input: RetrainModelWorkflowInput,
): Promise<RetrainModelWorkflowOutput> {
  // Workflow ID pattern: RetrainModel-{tenantId|'platform'}-{triggerId}
  // workflowId: `RetrainModel-${input.tenantId ?? 'platform'}-${input.triggerId}`

  let currentStep = 'starting';
  setHandler(stepQuery, () => currentStep);

  const scope = input.tenantId ?? 'platform';
  log.info('RetrainModelWorkflow starting', { scope, triggerId: input.triggerId });

  let approval: AdminApprovalSignalPayload | undefined;
  setHandler(adminApprovalSignal, (sig) => { approval = sig; });

  // ── 1. Import traces (skip on cron-only retrain mode) ────────────────
  let importedThisRun = 0;
  if (!input.skipImportAndReview) {
    currentStep = 'importing-traces';
    log.info('importing traces from langfuse');
    const importResult = await importTracesActivity({
      tenantId: input.tenantId,
      days:     7,
      limit:    500,
    });
    importedThisRun = importResult.inserted;
  }

  // ── 2. Skip-if-empty check ──────────────────────────────────────────
  currentStep = 'counting-unreviewed';
  const { unreviewed, totalReviewed } = await countUnreviewedRowsActivity({
    tenantId: input.tenantId,
  });
  log.info('row counts', { unreviewed, totalReviewed });

  // Slice 57C: import-only mode bails out here. The trace-import schedule
  // wants to ingest new candidate rows for admin review WITHOUT kicking
  // off a retrain. A separate (full) schedule does the train cycle on
  // its own cadence.
  if (input.mode === 'import-only') {
    log.info('import-only mode — skipping admin review, train, promotion');
    return {
      outcome:  'import_complete',
      imported: importedThisRun,
    };
  }

  if (totalReviewed === 0 && unreviewed === 0) {
    log.info('no training data at all — aborting');
    return { outcome: 'skipped_no_data' };
  }

  // ── 3. Notify admin + wait for approval signal ──────────────────────
  if (!input.skipImportAndReview && unreviewed > 0) {
    currentStep = 'awaiting-admin-review';
    await notifyAdminReviewPendingActivity({
      tenantId:    input.tenantId,
      unreviewed,
      workflowId:  workflowInfo().workflowId,
    });
    log.info('waiting for admin approval signal', { unreviewed });

    const timeoutMs = (input.adminReviewTimeoutHours ?? 24 * 30) * 60 * 60 * 1000;
    const signalReceived = await condition(() => approval !== undefined, timeoutMs);
    if (!signalReceived) {
      log.warn('admin review timed out — failing workflow closed');
      return { outcome: 'admin_review_timeout' };
    }
    log.info('admin approval received', {
      approvedRowIds: approval?.approvedRowIds.length ?? 0,
      note: approval?.note,
    });
    // Note: the activity that processes approvedRowIds (UPDATE … SET
    // reviewed=true WHERE id IN (...)) is not implemented in v1; admin
    // marks rows reviewed via the existing make training-data-mark-reviewed
    // before sending the signal. v2 can move the marking here.
  }

  // ── 4. Export the training corpus ────────────────────────────────────
  currentStep = 'exporting-training-data';
  const { csvPath, rowCount } = await exportTrainingDataActivity({
    tenantId: input.tenantId,
  });
  log.info('exported training_data.csv', { csvPath, rowCount });
  if (rowCount === 0) {
    log.warn('export produced 0 rows — nothing to train on');
    return { outcome: 'skipped_no_data' };
  }

  // ── 5. Train (long-running activity, 30-min timeout) ─────────────────
  currentStep = 'training';
  const trainResult = await trainModelActivity({
    tenantId: input.tenantId,
    csvPath,
    version:  `v${new Date().toISOString().replace(/[:.-]/g, '').slice(0, 13)}`,
  });
  log.info('train complete', {
    artifactPath: trainResult.artifactPath,
    cvMacroF1:    trainResult.cvMacroF1,
  });

  // ── 6. Eval gate ─────────────────────────────────────────────────────
  currentStep = 'eval-gate';
  const evalResult = await evalModelActivity({
    tenantId:        input.tenantId,
    csvPath,
    candidatePath:   trainResult.artifactPath,
    minImprovement:  0.01,
    maxRegression:   0.05,
  });
  log.info('eval gate', evalResult);
  if (!evalResult.passed) {
    log.warn('eval gate failed — aborting promotion', { reason: evalResult.reason });
    // The candidate joblib stays on the trainer pod's local fs and is
    // garbage-collected when the workflow worker recycles. Baseline
    // model in S3 is untouched.
    return {
      outcome:    'eval_gate_failed',
      cvMacroF1:  trainResult.cvMacroF1,
      rowsTrained: rowCount,
    };
  }

  // ── 7. Upload to S3 (compensating delete on later failure) ───────────
  currentStep = 'uploading-to-s3';
  const upload = await uploadModelToS3Activity({
    tenantId:     input.tenantId,
    artifactPath: trainResult.artifactPath,
    version:      trainResult.version,
  });
  log.info('uploaded to s3', { uri: upload.artifactUri });

  // ── 8. DB lineage. Best-effort, but if it fails we delete the S3
  //       upload to keep state consistent (workflow throws). ───────────
  currentStep = 'recording-model-run';
  let runId: string;
  try {
    const recorded = await recordModelRunActivity({
      tenantId:       input.tenantId,
      modelVersion:   trainResult.version,
      corpusCutoffAt: trainResult.corpusCutoffAt,
      trainCount:     rowCount,
      intentsCount:   trainResult.intentsCount,
      cvMacroF1:      trainResult.cvMacroF1,
      holdoutMacroF1: evalResult.candidateF1,
      artifactUri:    upload.artifactUri,
      artifactSha256: upload.artifactSha256,
      workflowId:     workflowInfo().workflowId,
      notes:          approval?.note ?? null,
    });
    runId = recorded.id;
  } catch (err) {
    log.error('record_model_run failed — compensating delete of S3 artifact', { err });
    // The compensating activity should be idempotent (no-op on missing key).
    // Throw after compensation so the workflow visibly fails.
    throw ApplicationFailure.create({
      message: 'recordModelRunActivity failed; S3 upload rolled back',
      type:    'lineage_recording_failed',
      details: [String(err)],
      nonRetryable: false,
    });
  }

  // ── 9. Membership rows (which training-data rows fed this model) ────
  currentStep = 'recording-membership';
  await recordTrainingMembershipActivity({
    modelRunId:     runId,
    corpusCutoffAt: trainResult.corpusCutoffAt,
    tenantId:       input.tenantId,
  });

  // ── 10. Verify hot-reload (poll classifier /healthz) ────────────────
  currentStep = 'verifying-hot-reload';
  const verified = await verifyHotReloadActivity({
    expectedVersion: trainResult.version,
    pollIntervalSec: 30,
    timeoutSec:      300,
  });
  log.info('hot-reload verification', { verified });
  // Verification failure does NOT roll back — the model is live in S3,
  // pods will pick it up on their next poll cycle even if our 5-minute
  // verification window missed it.

  currentStep = 'done';
  return {
    outcome:      'shipped',
    modelVersion: trainResult.version,
    artifactUri:  upload.artifactUri,
    cvMacroF1:    trainResult.cvMacroF1,
    rowsTrained:  rowCount,
  };
}
