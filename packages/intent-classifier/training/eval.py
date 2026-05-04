"""Slice 56: held-out evaluation against the current production artifact.

Reads training_data.csv, splits into train/test (stratified, 80/20),
trains a fresh pipeline on the train half, and reports per-intent
precision / recall / F1.

Eval gate (used by `make classifier-eval`):
  - macro F1 must beat the prior artifact by ≥ 1pp
  - no single intent's F1 may regress by > 5pp

The script EXITS NON-ZERO if the gate fails — CI uses this as a
hard merge block on PRs that bump training data + retrain.

Usage:

    python -m packages.intent-classifier.training.eval [--baseline path/to/old.joblib]
"""

from __future__ import annotations
import argparse
import csv
import sys
from pathlib import Path

import joblib
from sklearn.metrics import classification_report, f1_score
from sklearn.model_selection import train_test_split

from .train import build_pipeline


def load_rows(csv_path: Path) -> list[dict]:
    rows = []
    with csv_path.open(newline="", encoding="utf-8") as fh:
        reader = csv.DictReader(fh)
        for row in reader:
            text = (row.get("text") or "").strip()
            intent = (row.get("intent") or "").strip()
            # Slice 56M: is_synthetic flag distinguishes LLM-augmented rows
            # from human-curated. Default false for pre-56M rows.
            is_synth = (row.get("is_synthetic") or "false").strip().lower() == "true"
            if text and intent:
                rows.append({"text": text, "intent": intent, "is_synthetic": is_synth})
    return rows


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--csv", type=Path,
                        default=Path("packages/intent-classifier/training/training_data.csv"))
    parser.add_argument("--baseline", type=Path,
                        default=None,
                        help="Optional: path to prior .joblib for regression check")
    parser.add_argument("--min-improvement", type=float, default=0.01,
                        help="Required macro-F1 improvement vs baseline (default 0.01)")
    parser.add_argument("--max-regression", type=float, default=0.05,
                        help="Max per-intent F1 regression allowed (default 0.05)")
    args = parser.parse_args()

    if not args.csv.exists():
        print(f"ERROR: {args.csv} not found.", file=sys.stderr)
        return 1

    rows = load_rows(args.csv)

    # Slice 56M: split synthetic from real BEFORE the train/test split.
    # The eval gate measures real-world quality, so the holdout (test
    # set) must be real-only. Synthetic rows always go to train.
    real_rows = [r for r in rows if not r["is_synthetic"]]
    synth_rows = [r for r in rows if r["is_synthetic"]]
    print(f"Loaded {len(rows)} rows: {len(real_rows)} real + {len(synth_rows)} synthetic")
    if synth_rows:
        print(f"  Holdout will be drawn from real rows only; synthetic rows always in train.")

    if len(real_rows) < 2:
        print("ERROR: need ≥2 real (non-synthetic) rows to evaluate.", file=sys.stderr)
        return 1
    real_texts   = [r["text"]   for r in real_rows]
    real_intents = [r["intent"] for r in real_rows]
    if len(set(real_intents)) < 2:
        print("ERROR: need ≥2 distinct intents in real rows to evaluate.", file=sys.stderr)
        return 1

    # Stratified split on REAL rows only. Skip if any class has fewer
    # than 2 real examples (use random split as fallback).
    from collections import Counter
    if min(Counter(real_intents).values()) < 2:
        print("WARN: some intents have <2 real examples — using random split, not stratified.", file=sys.stderr)
        stratify = None
    else:
        stratify = real_intents

    X_train_real, X_test, y_train_real, y_test = train_test_split(
        real_texts, real_intents, test_size=0.2, random_state=42, stratify=stratify,
    )

    # Append synthetic rows to the train set (never to test).
    synth_texts   = [r["text"]   for r in synth_rows]
    synth_intents = [r["intent"] for r in synth_rows]
    X_train = list(X_train_real) + synth_texts
    y_train = list(y_train_real) + synth_intents

    candidate = build_pipeline()
    candidate.fit(X_train, y_train)
    y_pred = candidate.predict(X_test)
    candidate_f1 = f1_score(y_test, y_pred, average="macro", zero_division=0)
    print(f"\nCandidate macro F1: {candidate_f1:.3f}")
    print(f"\nCandidate per-class report:")
    print(classification_report(y_test, y_pred, zero_division=0))

    if not args.baseline:
        print("(no --baseline provided; skipping regression gate)")
        return 0

    if not args.baseline.exists():
        print(f"WARN: baseline {args.baseline} does not exist — skipping regression gate.")
        return 0

    baseline_bundle = joblib.load(args.baseline)
    baseline = baseline_bundle["pipeline"]
    y_pred_baseline = baseline.predict(X_test)
    baseline_f1 = f1_score(y_test, y_pred_baseline, average="macro", zero_division=0)
    print(f"\nBaseline macro F1: {baseline_f1:.3f}")
    delta = candidate_f1 - baseline_f1
    print(f"Delta (candidate - baseline): {delta:+.3f}")

    if delta < args.min_improvement:
        print(f"\nGATE FAILED: macro F1 improvement {delta:+.3f} < required {args.min_improvement:+.3f}", file=sys.stderr)
        return 2

    # Per-intent regression check
    from sklearn.metrics import precision_recall_fscore_support
    _, _, baseline_f1_per, _ = precision_recall_fscore_support(y_test, y_pred_baseline, zero_division=0)
    _, _, candidate_f1_per, _ = precision_recall_fscore_support(y_test, y_pred, zero_division=0)
    # NOTE: precision_recall_fscore_support orders by sorted unique label set in y_test.
    labels = sorted(set(y_test))
    for i, label in enumerate(labels):
        per_delta = candidate_f1_per[i] - baseline_f1_per[i]
        if per_delta < -args.max_regression:
            print(f"\nGATE FAILED: intent={label} F1 regressed by {-per_delta:.3f} (max allowed {args.max_regression:.3f})",
                  file=sys.stderr)
            return 2

    print("\nGATE PASSED.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
