// Slice 56N: activities for the RetrainModelWorkflow.
//
// Activities are TS thin wrappers that:
//   - DB-touching activities run SQL directly (importTraces, count,
//     recordModelRun, recordMembership)
//   - script-touching activities invoke the existing Python scripts via
//     a sidecar contract — this keeps the Python code as the single
//     source of truth (we don't reimplement train + eval in TS) but
//     gives Temporal observable, retriable wrappers over them.
//
// The script-touching activities use a small helper that POSTs to the
// intent-classifier service's `/admin/run-script` endpoint (slice 56N
// adds this endpoint). Alternative considered: kubectl exec — rejected
// because it requires elevated RBAC on the worker pod.

import {
  importTracesActivity,
  countUnreviewedRowsActivity,
} from './trace-import.activity.js';
import {
  notifyAdminReviewPendingActivity,
} from './notify-admin-review.activity.js';
import {
  exportTrainingDataActivity,
  trainModelActivity,
  evalModelActivity,
} from './run-trainer-script.activity.js';
import {
  uploadModelToS3Activity,
  verifyHotReloadActivity,
} from './model-promotion.activity.js';
import {
  recordModelRunActivity,
  recordTrainingMembershipActivity,
} from './record-lineage.activity.js';

export {
  importTracesActivity,
  countUnreviewedRowsActivity,
  notifyAdminReviewPendingActivity,
  exportTrainingDataActivity,
  trainModelActivity,
  evalModelActivity,
  uploadModelToS3Activity,
  verifyHotReloadActivity,
  recordModelRunActivity,
  recordTrainingMembershipActivity,
};
