> **⚠️ SUPERSEDED 2026-05-06 by [SLICE_61](../SLICE_61_REMOVE_INTENT_CLASSIFIER.md).**
> The infrastructure described here was removed in slice 61.
> Doc preserved for history.

# Slice 56C — in-cluster classifier trainer

Auto-retrain the intent classifier on a schedule, in-cluster. Removes
the workstation step (port-forward + manual `make classifier-train`)
that 56B still required for production retrains.

## Decisions

| Q | A | Why |
|---|---|---|
| Schedule | weekly, Sunday 02:30 UTC, configurable | Training data accumulates over the week from /teach + (56E) trace export. Daily would mostly retrain on no-op deltas. |
| Skip when nothing changed? | Yes — entrypoint queries `bot_intent_classifier_status` first; exits 0 if `untrained == 0` | Avoids needless artifact churn + `bot_intent_model_runs` row + S3 upload when there's no signal. |
| Image | Reuse `intent-classifier` image | All deps already there (sklearn, boto3, psycopg). One image, two entrypoints (uvicorn for service; cron_entrypoint.sh for trainer). |
| DB connection | In-cluster via `hr-service-credentials.DATABASE_URL_HR` (no port-forward) | Same secret already trusted by hr-service. Trainer is read-mostly + INSERT into the lifecycle tables; same RLS/connection user. |
| Ad-hoc trigger | `make classifier-retrain-now` → `kubectl create job --from=cronjob/...` | No new MCP tool, no kubernetes-Python-client RBAC. The Job spec lives in Helm; ad-hoc just instantiates it. |
| Eval gate? | No — trainer skips the `eval` step v1 | `make classifier-eval` requires a baseline `.joblib` path; in-cluster, baseline = whatever S3 currently points at. Adding compare-vs-S3-baseline is a 56C followup; for now we accept that an automated retrain could regress. Mitigation: deployed_at lag means humans can `aws s3 cp` an older CURRENT.json to roll back. |

## Files

| File | Change |
|---|---|
| `packages/intent-classifier/training/export_training_data.py` (new) | Python equivalent of `scripts/training-data-export.sh` — queries `bot_intent_training_data` directly via psycopg, merges with `manual_examples.csv` from disk, writes `/tmp/training_data.csv`. |
| `packages/intent-classifier/training/cron_entrypoint.sh` (new) | 1) checks `untrained` count via psql; 2) early-exits if 0; 3) runs export → train → upload chain. |
| `packages/intent-classifier/training/upload.py` | `_pg_url()` prefers `DATABASE_URL_HR` over `DATABASE_URL_HR_LOCAL` (in-cluster name wins; workstation still works via the local override). |
| `packages/intent-classifier/Dockerfile` | COPY the cron entrypoint + make it executable. |
| `packages/intent-classifier/helm/templates/trainer-cronjob.yaml` (new) | The CronJob spec. Both secret refs (`intent-classifier-credentials` for S3, `hr-service-credentials` for DB). |
| `packages/intent-classifier/helm/values.yaml` | `trainer.schedule`, `trainer.minUntrained` knobs. |
| `Makefile` | `classifier-retrain-now` target — `kubectl create job --from=cronjob/intent-classifier-trainer trainer-manual-$(date +%s)`. |

## Out of scope

- Per-train eval gate that compares cv-on-new-train vs prior-prod F1.
- A trainer image distinct from the service image (could shave deploy
  size; not worth the multi-image build pipeline today).
