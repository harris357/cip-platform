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

# Slice 56H: trust-tier-aware candidate query.
# Pull rows that match ANY of:
#   - explicit positive verdict (👍)                 → tier 4
#   - explicit negative verdict WITH correction text → tier 3
#   - clean-success heuristic                        → tier 2 / tier 1
#     (tier 2 if grammar/classifier routed; tier 1 if LLM-routed)
#
# We deliberately SKIP rows where user_verdict='negative' and
# user_correction IS NULL — we know it was wrong, but we don't know
# what was right; useless for training.
CANDIDATES_SQL = """
SELECT
    m.turn_id,
    m.tenant_id,
    m.langfuse_trace_id,
    m.tools_attempted[1]      AS tool,
    m.user_verdict,
    m.user_correction,
    m.grammar_pattern,
    m.classifier_decision,
    m.classifier_intent
  FROM bot_turn_metrics m
 WHERE m.emitted_at > %s
   AND m.langfuse_trace_id IS NOT NULL
   AND (
        -- tier 4: explicit positive verdict
        m.user_verdict = 'positive'
     OR -- tier 3: explicit negative with correction
        (m.user_verdict = 'negative' AND m.user_correction IS NOT NULL)
     OR -- tier 1/2: clean-success heuristic (only if NO negative-without-correction)
        (
          m.user_verdict IS DISTINCT FROM 'negative'
          AND array_length(m.tools_attempted, 1) = 1
          AND COALESCE(array_length(m.tools_refused, 1), 0) = 0
          AND m.clarification_fired = false
          AND m.confirmation_fired  = false
        )
       )
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
  (%s, 'trace_export', %s, %s, %s, 'call_tool', %s,
   %s, %s, %s, false)
"""


# ── Trust tiering ─────────────────────────────────────────────────────

def compute_trust_tier(row: tuple) -> tuple[int, str]:
    """Map a candidate row to (trust_tier, source_value).

    See SLICE_56_FAMILY_REVIEW.md section 1 for the ranking. Higher
    tier = more trustworthy training signal.

    Row tuple matches CANDIDATES_SQL projection:
    (turn_id, tenant_id, langfuse_trace_id, tool, user_verdict,
     user_correction, grammar_pattern, classifier_decision, classifier_intent)
    """
    (_, _, _, _, user_verdict, user_correction,
     grammar_pattern, classifier_decision, _) = row

    if user_verdict == 'positive':
        return (4, 'verdict_positive')
    if user_verdict == 'negative' and user_correction:
        return (3, 'confusion_correction')
    # Clean-success branches — distinguish LLM-routed from deterministic.
    if grammar_pattern is not None:
        return (2, 'trace_export')
    if classifier_decision in ('skip', 'narrow_plan'):
        return (2, 'trace_export')
    return (1, 'trace_export')


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
    by_tier: dict[int, int] = {1: 0, 2: 0, 3: 0, 4: 0}

    with psycopg.connect(_pg_url(), connect_timeout=10) as conn:
        for row in candidates:
            (turn_id, tenant_id, trace_id, tool,
             user_verdict, user_correction,
             _grammar_pattern, _classifier_decision, classifier_intent) = row

            # Slice 56H: compute trust tier from existing columns, then
            # use it to drive (a) the source value, (b) the intent
            # decision (negative-with-correction uses the classifier's
            # intent prediction NOT the tool-mapped intent), and (c) the
            # text-or-correction stored.

            tier, source_value = compute_trust_tier(row)
            by_tier[tier] += 1

            # Intent resolution: depends on tier.
            #   Tier 1/2 (clean-success): map from tool. Skip if no tool.
            #   Tier 3 (correction):     correction text is the *new* training
            #                             example for the classifier's predicted
            #                             intent — which was wrong. We need the
            #                             USER'S intent (what they wanted).
            #                             Without a structured "what intent did
            #                             you want?" picker, we conservatively
            #                             skip these in v1 and just flag for
            #                             admin review (the bot_intent_training_data
            #                             row gets the original tool's intent
            #                             but reviewed=false — admin relabels.)
            #   Tier 4 (positive):       same as tier 1/2 — tool-mapped intent.
            if tier == 3:
                # Negative + correction: trust the classifier's prediction
                # for what the user MIGHT have meant, but admin reviews
                # before any of these go to training. The correction
                # text becomes notes; the actual `text` is still the
                # user's original message.
                intent = classifier_intent or TOOL_TO_INTENT.get(tool, "out_of_scope")
            else:
                intent = TOOL_TO_INTENT.get(tool) if tool else None
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

            note_parts = [
                f"trace={trace_id[:8]}",
                f"tier={tier}",
            ]
            if user_correction:
                note_parts.append(f"correction={user_correction[:120]!r}")
            note_str = " | ".join(note_parts)

            if args.dry_run:
                print(f"  [DRY tier={tier}] tenant={str(tenant_id)[:8]} "
                      f"intent={intent} src={source_value} text={text[:60]!r}")
                inserted += 1
                continue

            with conn.cursor() as cur:
                cur.execute(INSERT_SQL, (
                    str(tenant_id), text, intent, tool,
                    source_value,
                    turn_id, trace_id,
                    note_str,
                ))
            inserted += 1
        if not args.dry_run:
            conn.commit()

    print()
    print(f"=== Import summary ({'DRY RUN' if args.dry_run else 'WRITE'}) ===")
    print(f"  inserted:                {inserted}")
    print(f"  by trust tier:")
    print(f"    tier 4 (👍 verdict):       {by_tier[4]}")
    print(f"    tier 3 (correction):       {by_tier[3]}")
    print(f"    tier 2 (grammar/clf):      {by_tier[2]}")
    print(f"    tier 1 (LLM-routed):       {by_tier[1]}")
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
