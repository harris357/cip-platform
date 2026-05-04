#!/usr/bin/env bash
# Slice 56C: in-cluster trainer CronJob entrypoint.
#
# 1. Skip-if-empty: ask the DB how many reviewed rows have arrived since
#    the most recent bot_intent_model_runs row's corpus_cutoff_at. If
#    that delta is below MIN_UNTRAINED, exit 0 without retraining.
# 2. Export training_data.csv from manual + DB.
# 3. Train + upload + record lineage.
#
# Env required:
#   DATABASE_URL_HR        — in-cluster postgres URL (from hr-service-credentials)
#   AWS_*                  — S3 creds (from intent-classifier-credentials)
#   MODEL_S3_BUCKET, MODEL_S3_PREFIX — from values.yaml
#   MIN_UNTRAINED          — int; default 1 (any new row triggers train)

set -euo pipefail

MIN_UNTRAINED="${MIN_UNTRAINED:-1}"
CSV_OUT="${CSV_OUT:-/tmp/training_data.csv}"
VERSION="${VERSION:-v$(date +%Y%m%d-%H%M)}"
# Slice 56D: when set (via `make classifier-retrain-now tenant=<id>`),
# this becomes a per-tenant train. The classifier-side gate for whether
# the tenant's model is actually consumed is CLASSIFIER_PER_TENANT_ENABLED.
TENANT_ID="${TENANT_ID:-}"
SCOPE_DESC="${TENANT_ID:+tenant=$TENANT_ID}"
SCOPE_DESC="${SCOPE_DESC:-platform}"

cd /app

if [[ -z "${DATABASE_URL_HR:-}" ]]; then
  echo "ERROR: DATABASE_URL_HR not set — check hr-service-credentials secret mount"
  exit 1
fi

# 1. Skip-if-empty. Per-tenant variant compares against that tenant's
# latest model_run cutoff (NULL → all reviewed rows for the tenant).
echo "[trainer] scope=$SCOPE_DESC"
UNTRAINED=$(python -c "
import os, psycopg, sys
url = os.environ['DATABASE_URL_HR']
tenant = os.environ.get('TENANT_ID') or None
if tenant:
    sql = '''
      SELECT COALESCE((
        SELECT COUNT(*) FROM bot_intent_training_data td
         WHERE td.reviewed = true AND td.tenant_id = %s
           AND td.added_at > (SELECT MAX(corpus_cutoff_at) FROM bot_intent_model_runs WHERE tenant_id = %s)
      ), (
        SELECT COUNT(*) FROM bot_intent_training_data WHERE reviewed = true AND tenant_id = %s
      ))
    '''
    params = (tenant, tenant, tenant)
else:
    sql = '''
      SELECT COALESCE((
        SELECT COUNT(*) FROM bot_intent_training_data td
         WHERE td.reviewed = true
           AND td.added_at > (SELECT MAX(corpus_cutoff_at) FROM bot_intent_model_runs WHERE tenant_id IS NULL)
      ), (
        SELECT COUNT(*) FROM bot_intent_training_data WHERE reviewed = true
      ))
    '''
    params = ()
with psycopg.connect(url, connect_timeout=10) as c:
    with c.cursor() as cur:
        cur.execute(sql, params)
        print(cur.fetchone()[0])
" 2>&1)

echo "[trainer] untrained reviewed rows since latest model: $UNTRAINED (min=$MIN_UNTRAINED)"

if [[ "$UNTRAINED" -lt "$MIN_UNTRAINED" ]]; then
  echo "[trainer] below threshold — skipping retrain"
  exit 0
fi

# 2. Export. Per-tenant export filters DB rows by tenant_id (manual CSV
# is included in both modes — it's the platform seed).
echo "[trainer] exporting training_data.csv…"
EXPORT_ARGS=(--csv-in /app/training/manual_examples.csv --csv-out "$CSV_OUT")
if [[ -n "$TENANT_ID" ]]; then
  EXPORT_ARGS+=(--tenant-id "$TENANT_ID")
fi
python -m training.export_training_data "${EXPORT_ARGS[@]}"

# 3. Slice 56J: eval gate. Pull the current baseline from S3 (CURRENT.json
# pointer + the joblib it references), then run eval.py to check that the
# CSV-trained candidate beats the baseline by ≥ MIN_IMPROVEMENT macro-F1
# AND no class regresses by > MAX_REGRESSION pp. eval.py exits 2 on
# regression failure → set -e propagates → cron job fails → no upload.
#
# First-time train: no baseline in S3 → eval.py skips the regression gate
# (its own --baseline missing handling). The cron job proceeds normally.
echo "[trainer] eval gate — checking candidate against baseline…"
BASELINE_PATH=""
python -c "
import os, sys, boto3, json
from botocore.exceptions import ClientError
bucket = os.environ.get('MODEL_S3_BUCKET', 'cip-platform-models')
prefix = os.environ.get('MODEL_S3_PREFIX', 'intent-classifier')
endpoint = os.environ.get('AWS_ENDPOINT_URL')
scope = os.environ.get('TENANT_ID')
key_prefix = f'{prefix}/by-tenant/{scope}' if scope else prefix
s3 = boto3.client('s3', endpoint_url=endpoint, region_name=os.environ.get('AWS_REGION', 'BHS'))
try:
    obj = s3.get_object(Bucket=bucket, Key=f'{key_prefix}/CURRENT.json')
    pointer = json.loads(obj['Body'].read())
    s3.download_file(Bucket=bucket, Key=pointer['key'], Filename='/tmp/baseline.joblib')
    print('downloaded')
except ClientError as e:
    code = e.response.get('Error', {}).get('Code', '')
    if code in ('NoSuchKey', '404'):
        print('no_baseline')
    else:
        print(f'fetch_error: {e}', file=sys.stderr)
        # Don't fail the cron just because we couldn't fetch the baseline
        # — fall through to the no-baseline path so the train still happens.
        print('no_baseline')
" > /tmp/baseline_status

if grep -q "downloaded" /tmp/baseline_status; then
  BASELINE_PATH="/tmp/baseline.joblib"
  echo "[trainer] baseline downloaded; running regression check"
  python -m training.eval --csv "$CSV_OUT" --baseline "$BASELINE_PATH" \
    --min-improvement "${MIN_IMPROVEMENT:-0.01}" \
    --max-regression  "${MAX_REGRESSION:-0.05}"
  EVAL_RC=$?
  if [[ "$EVAL_RC" -ne 0 ]]; then
    echo "[trainer] EVAL GATE FAILED (rc=$EVAL_RC) — aborting train, baseline stays live"
    exit 1
  fi
  echo "[trainer] eval gate passed"
else
  echo "[trainer] no baseline available (first train or S3 unreachable) — skipping regression gate"
fi

# 4. Train + upload + record lineage.
echo "[trainer] training version=$VERSION scope=$SCOPE_DESC…"
TRAIN_ARGS=(--csv "$CSV_OUT" --out-dir /tmp/models --version "$VERSION")
if [[ -n "$TENANT_ID" ]]; then
  TRAIN_ARGS+=(--tenant-id "$TENANT_ID")
fi
python -m training.train "${TRAIN_ARGS[@]}"

echo "[trainer] done. Pods will hot-load within MODEL_POLL_INTERVAL_SEC."
