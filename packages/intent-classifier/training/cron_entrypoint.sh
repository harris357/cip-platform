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

cd /app

if [[ -z "${DATABASE_URL_HR:-}" ]]; then
  echo "ERROR: DATABASE_URL_HR not set — check hr-service-credentials secret mount"
  exit 1
fi

# 1. Skip-if-empty.
# Use psycopg via Python so we don't need psql binary in the image.
UNTRAINED=$(python -c "
import os, psycopg, sys
url = os.environ['DATABASE_URL_HR']
sql = '''
  SELECT COALESCE((
    SELECT COUNT(*) FROM bot_intent_training_data td
     WHERE td.reviewed = true
       AND td.added_at > (SELECT MAX(corpus_cutoff_at) FROM bot_intent_model_runs)
  ), (
    SELECT COUNT(*) FROM bot_intent_training_data WHERE reviewed = true
  ))
'''
with psycopg.connect(url, connect_timeout=10) as c:
    with c.cursor() as cur:
        cur.execute(sql)
        print(cur.fetchone()[0])
" 2>&1)

echo "[trainer] untrained reviewed rows since latest model: $UNTRAINED (min=$MIN_UNTRAINED)"

if [[ "$UNTRAINED" -lt "$MIN_UNTRAINED" ]]; then
  echo "[trainer] below threshold — skipping retrain"
  exit 0
fi

# 2. Export.
echo "[trainer] exporting training_data.csv…"
python -m training.export_training_data \
  --csv-in  /app/training/manual_examples.csv \
  --csv-out "$CSV_OUT"

# 3. Train + upload + record lineage.
echo "[trainer] training version=$VERSION…"
python -m training.train \
  --csv      "$CSV_OUT" \
  --out-dir  /tmp/models \
  --version  "$VERSION"

echo "[trainer] done. Pods will hot-load within MODEL_POLL_INTERVAL_SEC."
