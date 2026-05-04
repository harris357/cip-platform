"""Slice 56C: Python equivalent of scripts/training-data-export.sh.

Used by the in-cluster trainer CronJob (no kubectl available in the
pod). Queries bot_intent_training_data via psycopg + reads
manual_examples.csv from disk, merges into a single training_data.csv.

Sources (in order — appended; later sources do NOT override earlier on
the same text, since the trainer's derive_intent_meta picks the most
common (tool, next_action) per intent):

  1. packages/intent-classifier/training/manual_examples.csv (committed
     into the image at /app/training/manual_examples.csv)
  2. bot_intent_training_data WHERE reviewed = true (DB)

DB connection comes from DATABASE_URL_HR (in-cluster) or
DATABASE_URL_HR_LOCAL (workstation port-forward). Same logic as
upload.py — keeps the two scripts symmetric.
"""

from __future__ import annotations

import csv
import logging
import os
import sys
from pathlib import Path

import psycopg

logger = logging.getLogger("trainer")


CSV_HEADER = ["text", "intent", "tool", "next_action", "source", "added_by", "added_at", "notes"]


def _pg_url() -> str:
    # Prefer in-cluster URL; fall back to the workstation port-forward.
    return (
        os.environ.get("DATABASE_URL_HR")
        or os.environ.get("DATABASE_URL_HR_LOCAL")
        or "postgresql://cipuser:"
           f"{os.environ.get('PG_USER_PASSWORD', '')}"
           "@localhost:15432/cip_hr"
    )


def export(
    *,
    csv_in: Path,
    csv_out: Path,
    tenant_id: str | None = None,
) -> tuple[int, int]:
    """Write merged training_data.csv. Returns (manual_count, db_count).

    If tenant_id is provided, restricts DB rows to that tenant — used
    by Slice 56D's per-tenant trainer mode."""
    csv_out.parent.mkdir(parents=True, exist_ok=True)
    manual_count = 0
    db_count     = 0

    with csv_out.open("w", newline="", encoding="utf-8") as fh_out:
        writer = csv.writer(fh_out)
        writer.writerow(CSV_HEADER)

        # 1. manual_examples.csv (skip header).
        if csv_in.exists():
            with csv_in.open(newline="", encoding="utf-8") as fh_in:
                reader = csv.reader(fh_in)
                next(reader, None)  # skip header
                for row in reader:
                    if not row:
                        continue
                    writer.writerow(row)
                    manual_count += 1

        # 2. DB rows (reviewed only).
        sql = """
            SELECT text, intent, COALESCE(tool, '') AS tool, next_action,
                   source, added_by, added_at::date::text AS added_at,
                   COALESCE(notes, '') AS notes
              FROM bot_intent_training_data
             WHERE reviewed = true
        """
        params: tuple = ()
        if tenant_id is not None:
            sql += " AND tenant_id = %s"
            params = (tenant_id,)
        sql += " ORDER BY added_at"

        try:
            with psycopg.connect(_pg_url(), connect_timeout=10) as conn:
                with conn.cursor() as cur:
                    cur.execute(sql, params)
                    for row in cur:
                        writer.writerow(row)
                        db_count += 1
        except Exception as e:
            # In-cluster failure should be loud — exit non-zero so the
            # CronJob retries on its next schedule rather than uploading
            # a truncated artifact.
            print(f"ERROR: failed to read bot_intent_training_data: {e}", file=sys.stderr)
            raise

    return manual_count, db_count


def main() -> int:
    import argparse
    parser = argparse.ArgumentParser(description="Export training_data.csv from manual + DB sources.")
    parser.add_argument("--csv-in",  type=Path, default=Path("/app/training/manual_examples.csv"))
    parser.add_argument("--csv-out", type=Path, default=Path("/tmp/training_data.csv"))
    parser.add_argument("--tenant-id", type=str, default=None,
                        help="Restrict DB rows to one tenant (Slice 56D per-tenant trainer)")
    args = parser.parse_args()

    manual, db = export(csv_in=args.csv_in, csv_out=args.csv_out, tenant_id=args.tenant_id)
    total = manual + db
    print(f"Exported {total} rows ({manual} manual + {db} DB) → {args.csv_out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
