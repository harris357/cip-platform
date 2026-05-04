"""Slice 56E: import labelled training rows from Langfuse traces.

Pulls clean-success turns from `bot_turn_metrics` (single tool ran,
no refusals, no clarification, no confirmation), fetches the raw user
text from the corresponding Langfuse trace, dedupes against the
existing corpus, and INSERTs reviewed=false rows into
bot_intent_training_data with source='trace_export'.

Operator workflow:

    make training-data-import-traces days=14
    make training-data-review                 # inspect imported rows
    make training-data-mark-reviewed ids='…'  # promote chosen ones
    make classifier-retrain-now               # next train picks them up

Environment:
    DATABASE_URL_HR / DATABASE_URL_HR_LOCAL — postgres
    LANGFUSE_HOST / LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY — trace API

Heuristic = strong implicit signal that the routing was right:
    array_length(tools_attempted, 1) = 1
  AND tools_refused = '{}'
  AND clarification_fired = false
  AND confirmation_fired = false
  AND langfuse_trace_id IS NOT NULL
  AND tool IN TOOL_TO_INTENT (so we can label it)

Why a hand-mapped tool→intent table? The classifier's own
`classifier_intent` is in bot_turn_metrics, but training on the
classifier's output is a feedback loop. Hand-mapping is the
conservative path; the map updates as new tools / extractors land.
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
from datetime import datetime, timedelta, timezone
from typing import Optional

import psycopg

logger = logging.getLogger("trainer")

# Conservative, hand-curated. Tools not listed → trace skipped.
# Add an entry alongside any new extractor / grammar pattern.
#
# Slice 56G: aligned with the manual_examples.csv intent labels.
# Existing rows used `find_employee` / `list_employees` (verb-prefix style);
# manual_examples.csv uses `employee_find` / `employee_list` (tool-name style).
# We standardize on tool-name-style here so import labels match the
# manual corpus and the trainer sees one set of intents per tool.
TOOL_TO_INTENT: dict[str, str] = {
    "employee_disable":         "disable_employee",
    "employee_find":            "employee_find",
    "employee_list":            "employee_list",
    "get_employee_permissions": "get_employee_permissions",
    "get_my_certifications":    "get_my_certifications",
    "get_staff_certifications": "get_staff_certifications",
}
# Note: out_of_scope is intent-only (no tool); it cannot be derived from
# tools_attempted because OOS turns by definition don't run a tool.
# OOS examples come from manual curation (manual_examples.csv) and
# (Slice 56F) explicit user 👎 verdicts on turns the bot tried to route.


def _pg_url() -> str:
    return (
        os.environ.get("DATABASE_URL_HR")
        or os.environ.get("DATABASE_URL_HR_LOCAL")
        or "postgresql://cipuser:"
           f"{os.environ.get('PG_USER_PASSWORD', '')}"
           "@localhost:15432/cip_hr"
    )


def _langfuse():
    """Construct a Langfuse SDK client. Lazy import so that --dry-run
    works without the SDK installed (handy in CI / local Python lacking
    the dep)."""
    try:
        from langfuse import Langfuse  # type: ignore[import-not-found]
    except ImportError as e:
        raise SystemExit(
            f"langfuse SDK not installed: {e}\n"
            "  pip install langfuse>=2,<4   (or use the in-cluster image)"
        )
    return Langfuse(
        host       = os.environ.get("LANGFUSE_HOST"),
        public_key = os.environ.get("LANGFUSE_PUBLIC_KEY"),
        secret_key = os.environ.get("LANGFUSE_SECRET_KEY"),
    )


# ── DB queries ────────────────────────────────────────────────────────

CANDIDATES_SQL = """
SELECT
    m.turn_id,
    m.tenant_id,
    m.langfuse_trace_id,
    m.tools_attempted[1] AS tool
  FROM bot_turn_metrics m
 WHERE m.emitted_at > %s
   AND array_length(m.tools_attempted, 1) = 1
   AND COALESCE(array_length(m.tools_refused, 1), 0) = 0
   AND m.clarification_fired = false
   AND m.confirmation_fired  = false
   AND m.langfuse_trace_id IS NOT NULL
"""

DEDUP_SQL = """
SELECT 1
  FROM bot_intent_training_data
 WHERE tenant_id = %s
   AND intent    = %s
   AND lower(text) = lower(%s)
 LIMIT 1
"""

INSERT_SQL = """
INSERT INTO bot_intent_training_data
  (tenant_id, added_by, text, intent, tool, next_action, source,
   source_turn_id, source_langfuse_trace_id, notes, reviewed)
VALUES
  (%s, 'trace_export', %s, %s, %s, 'call_tool', 'trace_export',
   %s, %s, %s, false)
"""


def fetch_user_text(lf, trace_id: str) -> Optional[str]:
    """Pull state.latestUserText from a trace's input. Returns None if
    the trace doesn't exist or doesn't carry the field (e.g. early
    pre-Slice-48 traces, or traces from a code path that doesn't seed
    latestUserText)."""
    try:
        trace = lf.api.trace.get(trace_id)
    except Exception as e:
        logger.warning("[import] trace fetch failed for %s: %s", trace_id[:8], e)
        return None
    inp = getattr(trace, "input", None)
    if inp is None:
        return None
    if isinstance(inp, dict):
        text = inp.get("latestUserText")
        return text if isinstance(text, str) and text.strip() else None
    # Some langfuse versions wrap input in a list of messages instead.
    # Best-effort: find the latest "human"/"user" message.
    if isinstance(inp, list):
        for m in reversed(inp):
            if isinstance(m, dict):
                role = (m.get("role") or m.get("type") or "").lower()
                if role in ("human", "user"):
                    content = m.get("content")
                    if isinstance(content, str) and content.strip():
                        return content
    return None


def main() -> int:
    parser = argparse.ArgumentParser(description="Import labelled training rows from Langfuse traces.")
    parser.add_argument("--days",    type=int, default=7,  help="Lookback window in days (default 7)")
    parser.add_argument("--limit",   type=int, default=500, help="Cap on rows to import per run (default 500)")
    parser.add_argument("--tenant-id", type=str, default=None,
                        help="Restrict to one tenant (default = all)")
    parser.add_argument("--dry-run", action="store_true",
                        help="Read-only: print what would be inserted without writing")
    args = parser.parse_args()

    cutoff = datetime.now(timezone.utc) - timedelta(days=args.days)
    logger.info("[import] window=%s tenant=%s limit=%d dry_run=%s",
                cutoff.isoformat(), args.tenant_id or "all", args.limit, args.dry_run)

    # 1. Pull candidates.
    sql = CANDIDATES_SQL
    params: tuple = (cutoff,)
    if args.tenant_id:
        sql += " AND m.tenant_id = %s"
        params = (cutoff, args.tenant_id)
    sql += " ORDER BY m.emitted_at DESC LIMIT %s"
    params = (*params, args.limit)

    with psycopg.connect(_pg_url(), connect_timeout=10) as conn:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            candidates = cur.fetchall()

    print(f"[import] candidate turns from bot_turn_metrics: {len(candidates)}")
    if not candidates:
        print("[import] nothing to import — done.")
        return 0

    lf = None  # lazy: only construct once we know there's work to do
    inserted = 0
    skipped_no_text     = 0
    skipped_no_intent   = 0
    skipped_dedup       = 0

    with psycopg.connect(_pg_url(), connect_timeout=10) as conn:
        for (turn_id, tenant_id, trace_id, tool) in candidates:
            intent = TOOL_TO_INTENT.get(tool)
            if intent is None:
                skipped_no_intent += 1
                continue

            if lf is None:
                lf = _langfuse()
            text = fetch_user_text(lf, trace_id)
            if not text:
                skipped_no_text += 1
                continue

            with conn.cursor() as cur:
                cur.execute(DEDUP_SQL, (str(tenant_id), intent, text))
                if cur.fetchone():
                    skipped_dedup += 1
                    continue

            if args.dry_run:
                print(f"  [DRY] tenant={str(tenant_id)[:8]} tool={tool} intent={intent} text={text[:60]!r}")
                inserted += 1
                continue

            with conn.cursor() as cur:
                cur.execute(INSERT_SQL, (
                    str(tenant_id), text, intent, tool,
                    turn_id, trace_id,
                    f"Auto-imported from Langfuse trace {trace_id[:8]}",
                ))
            inserted += 1
        if not args.dry_run:
            conn.commit()

    print()
    print(f"=== Import summary ({'DRY RUN' if args.dry_run else 'WRITE'}) ===")
    print(f"  inserted:                {inserted}")
    print(f"  skipped (dedup):         {skipped_dedup}")
    print(f"  skipped (no user text):  {skipped_no_text}")
    print(f"  skipped (unmapped tool): {skipped_no_intent}")
    if not args.dry_run and inserted > 0:
        print()
        print("Next: review with `make training-data-review`,")
        print("then promote chosen ids with `make training-data-mark-reviewed ids='…'`.")
    return 0


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    sys.exit(main())
