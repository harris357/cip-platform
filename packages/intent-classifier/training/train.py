"""Slice 56: train the sklearn intent classifier.

Reads training_data.csv (produced by `make training-data-export`),
fits a TfidfVectorizer + LogisticRegression pipeline, evaluates with
cross-validation, and saves the resulting joblib bundle to
packages/intent-classifier/models/.

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

Usage (from repo root):

    python -m packages.intent-classifier.training.train

Run from `make classifier-train` which sets up paths.
"""

from __future__ import annotations
import argparse
import csv
import sys
from collections import Counter
from datetime import date
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
    args = parser.parse_args()

    if not args.csv.exists():
        print(f"ERROR: {args.csv} not found. Run `make training-data-export` first.", file=sys.stderr)
        return 1

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
    if min_class < 2:
        print("WARN: at least one intent has only 1 example — skipping cross-val.", file=sys.stderr)
    else:
        cv_scores = cross_val_score(pipeline, texts, intents, cv=k, scoring="f1_macro")
        print(f"\nCross-val (k={k}) macro F1: mean={cv_scores.mean():.3f} std={cv_scores.std():.3f}")

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
    return 0


if __name__ == "__main__":
    sys.exit(main())
