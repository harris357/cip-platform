#!/usr/bin/env bash
# Slice 55 → 56B: mark bot_intent_training_data rows as reviewed.
#   bash scripts/training-data-mark-reviewed.sh 'uuid1,uuid2,uuid3'

set -euo pipefail

IDS_CSV="${1:-}"
[[ -z "$IDS_CSV" ]] && { echo "Usage: $0 'uuid1,uuid2,...'"; exit 1; }
[[ -z "${PG_USER_PASSWORD:-}" ]] && { echo "ERROR: source .envrc first"; exit 1; }

# Convert csv to PG array literal: '{uuid1,uuid2}'
ARRAY="{${IDS_CSV}}"

PSQL="kubectl exec -i -n cip-infra postgres-postgresql-0 -- env PGPASSWORD=$PG_USER_PASSWORD psql -U cipuser -d cip_hr"

$PSQL -c "
UPDATE bot_intent_training_data
   SET reviewed = true
 WHERE id = ANY('${ARRAY}'::uuid[])
RETURNING id, intent, next_action, LEFT(text, 60) AS text_preview;"
