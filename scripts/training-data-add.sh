#!/usr/bin/env bash
# Slice 55: interactive append to manual_examples.csv.
#
# Prompts for: text, intent, tool, next_action, notes.
# Validates next_action against the allowed enum.
# Appends a row with source='manual_csv', added_by=$USER, added_at=today.

set -euo pipefail

CSV="packages/intent-classifier/training/manual_examples.csv"
[[ ! -f "$CSV" ]] && { echo "ERROR: $CSV not found — run from repo root."; exit 1; }

ALLOWED_NEXT_ACTIONS="call_tool clarify answer_directly unknown"

prompt() {
  local var="$1" label="$2" default="${3:-}"
  read -r -p "  ${label}${default:+ [$default]}: " "$var"
  if [[ -z "${!var}" && -n "$default" ]]; then
    eval "$var='$default'"
  fi
}

echo "=== Add training example ==="
prompt TEXT       "text (the user phrasing)"
prompt INTENT     "intent (e.g. disable_employee)"
prompt TOOL       "tool (optional; e.g. employee_disable)" ""
echo "  next_action options: $ALLOWED_NEXT_ACTIONS"
prompt NEXT       "next_action"
prompt NOTES      "notes (optional)" ""

if [[ -z "$TEXT" || -z "$INTENT" || -z "$NEXT" ]]; then
  echo "ERROR: text, intent, next_action are required."
  exit 1
fi
if ! [[ " $ALLOWED_NEXT_ACTIONS " == *" $NEXT "* ]]; then
  echo "ERROR: next_action must be one of: $ALLOWED_NEXT_ACTIONS"
  exit 1
fi

ADDED_BY="${USER:-unknown}"
ADDED_AT=$(date -u +%Y-%m-%d)

# CSV-escape: wrap in quotes, double up internal quotes.
escape() { echo "\"${1//\"/\"\"}\""; }

ROW="$(escape "$TEXT"),$INTENT,${TOOL:-},${NEXT},manual_csv,${ADDED_BY},${ADDED_AT},$(escape "$NOTES")"

echo "$ROW" >> "$CSV"
echo ""
echo "Appended to $CSV:"
echo "  $ROW"
echo ""
echo "Don't forget to commit: git add $CSV && git commit"
