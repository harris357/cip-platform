#!/usr/bin/env bash
# Slice 56D follow-up: bootstrap a tenant's bot_intent_training_data
# from packages/intent-classifier/training/manual_examples.csv.
#
# Per-tenant classifier training (`make classifier-retrain-now tenant=<uuid>`)
# requires the trainer to find ≥ MIN_ROWS_PER_TENANT (50) and
# ≥ MIN_INTENTS_PER_TENANT (3) rows in bot_intent_training_data WHERE
# tenant_id = <uuid>. The committed manual_examples.csv lives outside the
# DB by default — this script imports it tagged with a chosen tenant_id
# so the threshold is cleared and per-tenant training has data to chew on.
#
# Idempotent: deletes existing source='manual_csv' rows for the tenant
# first, then re-inserts. /teach + trace_export rows (other sources)
# are untouched.
#
# Usage:
#   bash scripts/training-data-seed-tenant.sh <tenant-uuid>
#   make training-data-seed-tenant tenant=<tenant-uuid>

set -euo pipefail

TENANT_ID="${1:-}"
[[ -z "$TENANT_ID" ]] && { echo "Usage: $0 <tenant-uuid>"; exit 1; }
[[ -z "${PG_USER_PASSWORD:-}" ]] && { echo "ERROR: source .envrc first"; exit 1; }

CSV="packages/intent-classifier/training/manual_examples.csv"
[[ -f "$CSV" ]] && [[ "$(wc -l < "$CSV")" -gt 1 ]] || {
  echo "ERROR: $CSV not found or empty"; exit 1;
}

# Pipe the CSV into psql via a temp table → INSERT…SELECT pattern.
# Postgres' \COPY FROM STDIN handles CSV escaping correctly (quoted text
# fields with commas etc.); we don't need to parse in shell.
echo "→ Seeding tenant=$TENANT_ID from $CSV"

# Use kubectl exec -i to stream the heredoc (including CSV body) into psql.
{ cat <<EOF
BEGIN;

CREATE TEMP TABLE _seed_csv (
  text         TEXT,
  intent       TEXT,
  tool         TEXT,
  next_action  TEXT,
  source       TEXT,
  added_by     TEXT,
  added_at     DATE,
  notes        TEXT
) ON COMMIT DROP;

\\COPY _seed_csv FROM STDIN WITH (FORMAT CSV, HEADER);
EOF
  cat "$CSV"
  cat <<EOF
\\.

-- Idempotent: blow away prior manual_csv rows for this tenant.
-- /teach + trace_export rows are untouched (different sources).
DELETE FROM bot_intent_training_data
 WHERE tenant_id = '$TENANT_ID'::uuid
   AND source     = 'manual_csv';

INSERT INTO bot_intent_training_data
  (tenant_id, added_by, text, intent, tool, next_action, source,
   added_at, notes, reviewed)
SELECT
  '$TENANT_ID'::uuid,
  'bootstrap',
  text,
  intent,
  NULLIF(tool, ''),
  next_action,
  'manual_csv',
  added_at::timestamptz,
  NULLIF(notes, ''),
  true
FROM _seed_csv;

COMMIT;

\echo
\echo === Per-intent counts (tenant=$TENANT_ID, source=manual_csv) ===
SELECT intent, COUNT(*) AS rows
  FROM bot_intent_training_data
 WHERE tenant_id = '$TENANT_ID'::uuid
   AND source     = 'manual_csv'
 GROUP BY intent
 ORDER BY rows DESC;

\echo
\echo === Totals ===
SELECT
  COUNT(*)                                        AS total_rows,
  COUNT(DISTINCT intent)                          AS distinct_intents,
  COUNT(*) FILTER (WHERE reviewed)                AS reviewed_rows
  FROM bot_intent_training_data
 WHERE tenant_id = '$TENANT_ID'::uuid
   AND source     = 'manual_csv';

\echo
\echo Train this tenant with:  make classifier-retrain-now tenant=$TENANT_ID
\echo (Requires CLASSIFIER_PER_TENANT_ENABLED=true in .envrc and >= 50 rows / >= 3 intents.)
EOF
} | kubectl exec -i -n cip-infra postgres-postgresql-0 -- \
      env PGPASSWORD="$PG_USER_PASSWORD" psql -U cipuser -d cip_hr 2>&1 \
  | grep -vE '^(BEGIN|CREATE TABLE|COPY [0-9]+|DELETE [0-9]+|INSERT [0-9]+|COMMIT)$'
