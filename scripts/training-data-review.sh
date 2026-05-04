#!/usr/bin/env bash
# Slice 55 → 56B: list unreviewed bot_intent_training_data rows
# (from /teach + turn-label + future trace_export).
# Operator inspects, picks ones to keep, then runs:
#   make training-data-mark-reviewed ids='id1,id2,id3'

set -euo pipefail

[[ -z "${PG_USER_PASSWORD:-}" ]] && { echo "ERROR: source .envrc first"; exit 1; }

# Open temp port-forward
kubectl port-forward -n cip-infra svc/postgres-postgresql 15432:5432 &>/tmp/pf-review.log &
PF_PID=$!
trap 'kill "$PF_PID" 2>/dev/null || true' EXIT
sleep 2

PSQL="kubectl exec -i -n cip-infra postgres-postgresql-0 -- env PGPASSWORD=$PG_USER_PASSWORD psql -U cipuser -d cip_hr"

echo "=== Unreviewed bot_intent_training_data ==="
# Slice 56L: surface predicted_intent so confusion_correction rows show
# the original wrong prediction at a glance. The 'confused' column is
# blank when predicted_intent matches intent (no confusion to see) and
# shows "predicted=X" when they differ.
$PSQL -c "
SELECT id, added_at::date AS added, source, intent, tool, next_action,
       CASE
         WHEN predicted_intent IS DISTINCT FROM intent
           THEN 'predicted=' || predicted_intent
         ELSE ''
       END AS confused,
       LEFT(text, 60) AS text_preview,
       LEFT(COALESCE(notes,''), 50) AS notes
  FROM bot_intent_training_data
 WHERE reviewed = false
 ORDER BY added_at DESC
 LIMIT 50;"
echo ""
echo "Mark approved rows reviewed with:"
echo "  make training-data-mark-reviewed ids='id1,id2,id3'"
echo ""
echo "Confusion-matrix view (where predicted != corrected, last 30d):"
echo "  $ kubectl exec -n cip-infra postgres-postgresql-0 -- env PGPASSWORD=\$PG_USER_PASSWORD psql -U cipuser -d cip_hr -c \\"
echo "      \"SELECT predicted_intent, intent AS corrected_to, COUNT(*) AS n FROM bot_intent_training_data \\"
echo "       WHERE predicted_intent IS DISTINCT FROM intent \\"
echo "         AND added_at > NOW() - INTERVAL '30 days' \\"
echo "       GROUP BY 1,2 ORDER BY n DESC;\""
