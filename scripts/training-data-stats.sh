#!/usr/bin/env bash
# Slice 55 → 56B: per-intent training-row counts across all sources.
# Targets ~200 per intent to be useful for sklearn training.

set -euo pipefail

CSV="packages/intent-classifier/training/manual_examples.csv"

echo "=== manual_examples.csv (committed) ==="
if [[ -f "$CSV" ]]; then
  # Skip header. Count per-intent (column 2).
  tail -n +2 "$CSV" | awk -F, '{print $2}' | sort | uniq -c | sort -rn | sed 's/^/  /'
else
  echo "  (file not found)"
fi

echo ""
echo "=== bot_intent_training_data (DB; reviewed=true) ==="
echo "    Run from a workstation with kubectl + .envrc:"
echo ""
cat <<'SQL'
    psql -h localhost -p 15432 -U cipuser -d cip_hr -c \
      "SELECT intent, COUNT(*) FROM bot_intent_training_data WHERE reviewed=true GROUP BY intent ORDER BY count DESC;"
SQL
echo ""
echo "=== Recommendation ==="
echo "  The classifier needs ~200 rows per intent for reliable"
echo "  LogisticRegression training. Anything below ~100 will be noisy."
echo "  Use \`make training-data-add\` to bulk-import client doc"
echo "  phrasings, or /teach in Teams to ad-hoc add."
echo ""
echo "  Run \`make classifier-status\` to see how many reviewed rows are"
echo "  pending the next train."
