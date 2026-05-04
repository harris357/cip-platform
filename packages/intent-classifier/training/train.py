"""Slice 56 + 56B: train the sklearn intent classifier.

Reads training_data.csv (produced by `make training-data-export`),
fits a TfidfVectorizer + LogisticRegression pipeline, evaluates with
cross-validation, saves the resulting joblib bundle, then (Slice 56B):

  1. Uploads the artifact to s3://$MODEL_S3_BUCKET/$MODEL_S3_PREFIX/
  2. Updates CURRENT.json — the pointer the classifier service polls
  3. INSERTs a row into bot_intent_model_runs
  4. INSERTs membership rows for the training_data ids that fed it

Bundle shape (matches src/classifier.py expectations):

    {
        "version":     "v1-2026-05-03",
        "pipeline":    sklearn.pipeline.Pipeline,
        "intent_meta": { intent: { "tool": ..., "next_action": ... } },
        "intents":     sorted list of intent labels,
    }

Each intent's tool + next_action come from training_data.csv. If a
single intent shows multiple (tool, next_action) pairs across rows,
we pick the most common combo (mode).

Usage (from repo root, after sourcing .envrc and starting a port-forward
to the in-cluster postgres):

    kubectl port-forward -n cip-infra svc/postgres-postgresql 15432:5432 &
    python -m packages.intent-classifier.training.train
    # or just: make classifier-train

`--no-upload` skips S3 + DB writes (local dry-run).
"""

from __future__ import annotations
import argparse
import csv
import sys
from collections import Counter
from datetime import date, datetime, timezone
from pathlib import Path

import joblib
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import cross_val_score
from sklearn.pipeline import Pipeline


def load_training_data(csv_path: Path):
    rows = []
    with csv_path.open(newline="", encoding="utf-8") as fh:
        reader = csv.DictReader(fh)
        for row in reader:
            text   = (row.get("text") or "").strip()
            intent = (row.get("intent") or "").strip()
            if not text or not intent:
                continue
            rows.append({
                "text":        text,
                "intent":      intent,
                "tool":        (row.get("tool") or "").strip() or None,
                "next_action": (row.get("next_action") or "unknown").strip(),
            })
    return rows


def derive_intent_meta(rows) -> dict[str, dict[str, str]]:
    """For each intent, pick the most common (tool, next_action) combo."""
    by_intent: dict[str, list[tuple[str | None, str]]] = {}
    for r in rows:
        by_intent.setdefault(r["intent"], []).append((r["tool"], r["next_action"]))
    meta = {}
    for intent, combos in by_intent.items():
        most_common = Counter(combos).most_common(1)[0][0]
        meta[intent] = {"tool": most_common[0], "next_action": most_common[1]}
    return meta


def build_pipeline() -> Pipeline:
    return Pipeline([
        ("tfidf", TfidfVectorizer(
            analyzer="word",
            ngram_range=(1, 2),
            min_df=1,                # min_df=2 is better at scale; keep =1 for tiny seed sets
            max_df=0.95,
            lowercase=True,
            strip_accents="unicode",
            sublinear_tf=True,
        )),
        ("clf", LogisticRegression(
            max_iter=1000,
            class_weight="balanced",
            C=1.0,
            random_state=42,
        )),
    ])


def main() -> int:
    parser = argparse.ArgumentParser(description="Train the sklearn intent classifier.")
    parser.add_argument(
        "--csv", type=Path,
        default=Path("packages/intent-classifier/training/training_data.csv"),
    )
    parser.add_argument(
        "--out-dir", type=Path,
        default=Path("packages/intent-classifier/models"),
    )
    parser.add_argument(
        "--version", default=f"v1-{date.today().isoformat()}",
    )
    parser.add_argument(
        "--no-upload", action="store_true",
        help="Skip S3 upload + DB lineage writes (local dry-run).",
    )
    args = parser.parse_args()

    if not args.csv.exists():
        print(f"ERROR: {args.csv} not found. Run `make training-data-export` first.", file=sys.stderr)
        return 1

    # Lock the cutoff BEFORE training. Any rows added during fit aren't
    # claimed by this run — they fall into the next run's untrained set.
    corpus_cutoff_at = datetime.now(timezone.utc)

    rows = load_training_data(args.csv)
    if len(rows) < 5:
        print(f"ERROR: only {len(rows)} training rows — need at least ~5 to train anything.", file=sys.stderr)
        return 1

    texts   = [r["text"]   for r in rows]
    intents = [r["intent"] for r in rows]
    intent_counts = Counter(intents)
    print(f"Loaded {len(rows)} rows across {len(intent_counts)} intents:")
    for intent, count in intent_counts.most_common():
        print(f"  {count:5d}  {intent}")

    pipeline = build_pipeline()

    # k-fold cross-val (k = min(5, smallest-class-count) so every fold has every class)
    min_class = min(intent_counts.values())
    k = max(2, min(5, min_class))
    cv_macro_f1: float | None = None
    if min_class < 2:
        print("WARN: at least one intent has only 1 example — skipping cross-val.", file=sys.stderr)
    else:
        cv_scores = cross_val_score(pipeline, texts, intents, cv=k, scoring="f1_macro")
        cv_macro_f1 = float(cv_scores.mean())
        print(f"\nCross-val (k={k}) macro F1: mean={cv_macro_f1:.3f} std={cv_scores.std():.3f}")

    pipeline.fit(texts, intents)
    intent_meta = derive_intent_meta(rows)

    args.out_dir.mkdir(parents=True, exist_ok=True)
    out_path = args.out_dir / f"classifier-{args.version}.joblib"
    joblib.dump({
        "version":     args.version,
        "pipeline":    pipeline,
        "intent_meta": intent_meta,
        "intents":     sorted(set(intents)),
    }, out_path)
    print(f"\nSaved {out_path}")

    if args.no_upload:
        print("\n--no-upload set — skipping S3 + DB writes.")
        return 0

    # ── Slice 56B: ship the artifact to S3 + record lineage ──────────
    # Imported lazily so --no-upload + missing boto3/psycopg still trains.
    try:
        from .upload import (
            ensure_bucket, upload_artifact, update_current_pointer,
            record_model_run, record_membership,
        )
    except ImportError as e:
        print(f"\nWARN: --no-upload not set but upload deps missing ({e}). "
              f"Artifact saved locally only.", file=sys.stderr)
        return 0

    try:
        ensure_bucket()
        artifact_uri, artifact_sha256 = upload_artifact(args.version, out_path)
        # Pointer goes LAST so readers never see a CURRENT pointing at a
        # not-yet-uploaded key.
        update_current_pointer(args.version, f"{artifact_uri.split('/', 3)[-1]}", artifact_sha256)
    except Exception as e:
        print(f"\nERROR: S3 upload failed: {e}", file=sys.stderr)
        print(f"Artifact remains at {out_path} — you can retry the upload manually.", file=sys.stderr)
        return 2

    # DB writes are best-effort: an upload that succeeds without DB
    # lineage is still useful (the classifier hot-loads it). Log loudly
    # and let the operator backfill via psql if needed.
    run_id = record_model_run(
        model_version    = args.version,
        corpus_cutoff_at = corpus_cutoff_at,
        train_count      = len(rows),
        intents_count    = len(intent_counts),
        cv_macro_f1      = cv_macro_f1,
        holdout_macro_f1 = None,
        artifact_uri     = artifact_uri,
        artifact_sha256  = artifact_sha256,
    )
    if run_id:
        record_membership(run_id, corpus_cutoff_at)

    print(f"\n=== Trained, uploaded, recorded ===")
    print(f"  version:    {args.version}")
    print(f"  artifact:   {artifact_uri}")
    print(f"  cutoff:     {corpus_cutoff_at.isoformat()}")
    print(f"  rows:       {len(rows)}")
    print(f"  intents:    {len(intent_counts)}")
    if cv_macro_f1 is not None:
        print(f"  cv_macro_f1: {cv_macro_f1:.3f}")
    print(f"  Classifier pods will hot-load within MODEL_POLL_INTERVAL_SEC (default 60s).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
