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

# 3. Train + upload + record lineage.
echo "[trainer] training version=$VERSION scope=$SCOPE_DESC…"
TRAIN_ARGS=(--csv "$CSV_OUT" --out-dir /tmp/models --version "$VERSION")
if [[ -n "$TENANT_ID" ]]; then
  TRAIN_ARGS+=(--tenant-id "$TENANT_ID")
fi
python -m training.train "${TRAIN_ARGS[@]}"

echo "[trainer] done. Pods will hot-load within MODEL_POLL_INTERVAL_SEC."
