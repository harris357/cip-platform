#!/usr/bin/env bash
# Slice 56B: snapshot of intent-classifier state.
# Shows:
#   - latest bot_intent_model_runs row (which version is current)
#   - count of reviewed bot_intent_training_data rows added since the
#     latest run's corpus_cutoff_at (= candidates for the next train)
#   - what the live pods report via /healthz (loaded version + intents)
#
# Uses the in-cluster postgres pod via kubectl exec (no port-forward
# needed) and kubectl exec into a classifier pod for /healthz.

set -euo pipefail

[[ -z "${PG_USER_PASSWORD:-}" ]] && { echo "ERROR: source .envrc first"; exit 1; }

PSQL="kubectl exec -i -n cip-infra postgres-postgresql-0 -- env PGPASSWORD=$PG_USER_PASSWORD psql -U cipuser -d cip_hr"

echo "=== Latest model run ==="
$PSQL -c "
SELECT model_version,
       trained_at::timestamp(0)        AS trained_at,
       corpus_cutoff_at::timestamp(0)  AS corpus_cutoff_at,
       train_count,
       intents_count,
       ROUND(cv_macro_f1::numeric, 3)  AS cv_f1,
       ROUND(holdout_macro_f1::numeric, 3) AS holdout_f1,
       deployed_at::timestamp(0)       AS deployed_at,
       deprecated_at::timestamp(0)     AS deprecated_at
  FROM bot_intent_model_runs
 ORDER BY trained_at DESC
 LIMIT 5;"

echo ""
echo "=== Untrained rows since latest run (cross-tenant) ==="
$PSQL -t -A -c "
SELECT
  COALESCE((
    SELECT COUNT(*) FROM bot_intent_training_data td
     WHERE td.reviewed = true
       AND td.added_at > (SELECT MAX(corpus_cutoff_at) FROM bot_intent_model_runs)
  ), (
    SELECT COUNT(*) FROM bot_intent_training_data WHERE reviewed = true
  )) AS untrained_count;
" | sed 's/^/  /'

echo ""
echo "=== Live classifier /healthz (per pod) ==="
PODS=$(kubectl get pods -n cip-app -l app=intent-classifier -o jsonpath='{.items[*].metadata.name}' 2>/dev/null || true)
if [[ -z "$PODS" ]]; then
  echo "  (no intent-classifier pods found in cip-app)"
else
  for pod in $PODS; do
    printf "  %-50s " "$pod"
    # Use Python (already in the slim image) — wget isn't.
    kubectl exec -n cip-app "$pod" -- python -c "
import urllib.request, json, sys
try:
    r = urllib.request.urlopen('http://localhost:8000/healthz', timeout=3)
    print(json.dumps(json.loads(r.read())))
except Exception as e:
    print(json.dumps({'err': str(e)}))
" 2>/dev/null || echo '{"err":"exec_failed"}'
  done
fi

echo ""
echo "Train + ship a new model with:  make classifier-train"
echo "(Pods hot-load within MODEL_POLL_INTERVAL_SEC — default 60s.)"
