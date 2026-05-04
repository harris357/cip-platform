#!/usr/bin/env bash
# Slice 55 → 56B: merge all training-data sources into one canonical CSV
# that Slice 56's sklearn pipeline consumes.
#
# Sources (in order — later sources override earlier on the same text):
#   1. packages/intent-classifier/training/manual_examples.csv (committed)
#   2. bot_intent_training_data WHERE reviewed=true (DB)
#   3. (Slice 56e) Langfuse traces — auto-labelled high-confidence successful turns
#
# Output: packages/intent-classifier/training/training_data.csv

set -euo pipefail

[[ -z "${PG_USER_PASSWORD:-}" ]] && { echo "ERROR: source .envrc first"; exit 1; }

CSV_IN="packages/intent-classifier/training/manual_examples.csv"
CSV_OUT="packages/intent-classifier/training/training_data.csv"

# Open temp port-forward
kubectl port-forward -n cip-infra svc/postgres-postgresql 15432:5432 &>/tmp/pf-export.log &
PF_PID=$!
trap 'kill "$PF_PID" 2>/dev/null || true' EXIT
sleep 2

# Header
echo 'text,intent,tool,next_action,source,added_by,added_at,notes' > "$CSV_OUT"

# 1. manual_examples.csv (skip header line)
if [[ -f "$CSV_IN" ]]; then
  tail -n +2 "$CSV_IN" >> "$CSV_OUT"
  COUNT_MANUAL=$(($(wc -l < "$CSV_IN") - 1))
else
  COUNT_MANUAL=0
fi

# 2. DB rows (reviewed only). Use COPY TO STDOUT for clean CSV escaping.
COUNT_DB=$(kubectl exec -i -n cip-infra postgres-postgresql-0 -- \
  env PGPASSWORD="$PG_USER_PASSWORD" psql -U cipuser -d cip_hr -t -A -c "
    SELECT COUNT(*) FROM bot_intent_training_data WHERE reviewed = true;
  " | tr -d '[:space:]')

kubectl exec -i -n cip-infra postgres-postgresql-0 -- \
  env PGPASSWORD="$PG_USER_PASSWORD" psql -U cipuser -d cip_hr -c "\COPY (
    SELECT text, intent, COALESCE(tool, '') AS tool, next_action,
           source, added_by, added_at::date AS added_at, COALESCE(notes, '') AS notes
      FROM bot_intent_training_data
     WHERE reviewed = true
     ORDER BY added_at
  ) TO STDOUT WITH CSV" >> "$CSV_OUT"

TOTAL=$(($(wc -l < "$CSV_OUT") - 1))

echo ""
echo "=== Exported to $CSV_OUT ==="
echo "  manual_examples.csv:        $COUNT_MANUAL rows"
echo "  bot_intent_training_data:   $COUNT_DB rows"
echo "  total:                      $TOTAL rows"
echo ""
echo "Per-intent counts:"
tail -n +2 "$CSV_OUT" | awk -F, '{print $2}' | sort | uniq -c | sort -rn | sed 's/^/  /'
