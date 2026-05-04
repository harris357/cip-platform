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
$PSQL -c "
SELECT id, added_at::date AS added, added_by, source, intent, tool, next_action,
       LEFT(text, 80) AS text_preview, LEFT(COALESCE(notes,''), 40) AS notes
  FROM bot_intent_training_data
 WHERE reviewed = false
 ORDER BY added_at DESC
 LIMIT 50;"
echo ""
echo "Mark approved rows reviewed with:"
echo "  make training-data-mark-reviewed ids='id1,id2,id3'"
