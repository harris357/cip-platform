"""Slice 56: model loader + predict wrapper.

The model artifact is a joblib-pickled dict:

    {
        "version":     "v1-2026-05-03",
        "pipeline":    sklearn.pipeline.Pipeline,
        "intent_meta": { intent_name: { "tool": "...", "next_action": "..." } },
        "intents":     [ ... sorted list of intent labels (mirrors pipeline.classes_) ... ],
    }

`tool` and `next_action` are looked up from `intent_meta` rather than
predicted by the model. Each intent maps to a single tool + next_action
in v1; if a turn could be either call_tool OR clarify (e.g.,
disable_employee — depends on whether the message is specific enough),
the GRAMMAR ROUTER + EXTRACTOR (Slice 55) handles the call_tool branch
deterministically and the classifier predicts intent='disable_employee'
+ next_action='clarify' as the default.

Loaded once at process boot. Multi-replica safe — model is read-only.

Failure to load → exit non-zero so kubernetes restarts the pod (and
the bot's classify graph node falls through to triage in the meantime).
"""

from __future__ import annotations
import logging
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import joblib
import numpy as np

logger = logging.getLogger("intent-classifier")

# Default location — Dockerfile copies models/ into /app/models/.
# Override via INTENT_CLASSIFIER_MODEL_PATH for local dev or testing.
_DEFAULT_MODEL_DIR = Path(os.environ.get("INTENT_CLASSIFIER_MODEL_PATH", "/app/models"))


class _ModelState:
    pipeline = None        # sklearn.pipeline.Pipeline
    intents: list[str] = []
    intent_meta: dict[str, dict[str, str]] = {}
    version: Optional[str] = None
    loaded_at: Optional[datetime] = None


_state = _ModelState()


def load_model() -> None:
    """Find the latest .joblib in the model dir and load it.
    Conventional naming: classifier-v<NN>-<YYYY-MM-DD>.joblib.
    Falls back to any .joblib if the convention isn't met.
    """
    if not _DEFAULT_MODEL_DIR.exists():
        logger.error("[classifier] model dir does not exist: %s", _DEFAULT_MODEL_DIR)
        sys.exit(1)

    candidates = sorted(_DEFAULT_MODEL_DIR.glob("*.joblib"), reverse=True)
    if not candidates:
        # Bootstrap allowance: no model yet. Run in degraded mode (always
        # returns "unknown" with confidence 0.0) so the bot's classify
        # node treats it as fallthrough. Useful in CI before the first
        # training run.
        logger.warning(
            "[classifier] no .joblib found in %s — running in DEGRADED mode (returns 'unknown'/0.0). "
            "Build a model with `make classifier-train` and rebuild the image.",
            _DEFAULT_MODEL_DIR,
        )
        return

    artifact_path = candidates[0]
    logger.info("[classifier] loading %s", artifact_path)
    try:
        bundle = joblib.load(artifact_path)
        _state.pipeline    = bundle["pipeline"]
        _state.intents     = sorted(bundle.get("intents", list(_state.pipeline.classes_)))
        _state.intent_meta = bundle.get("intent_meta", {})
        _state.version     = bundle.get("version", artifact_path.stem)
        _state.loaded_at   = datetime.now(timezone.utc)
        logger.info("[classifier] loaded version=%s intents=%d", _state.version, len(_state.intents))
    except Exception:
        logger.exception("[classifier] failed to load %s", artifact_path)
        sys.exit(1)


def is_loaded() -> bool:
    return _state.pipeline is not None


def get_state() -> _ModelState:
    return _state


def predict(text: str) -> dict:
    """Return the classifier's prediction for `text`.

    Always returns a dict matching schema.ClassifyResponse — degraded
    mode (no model loaded) returns intent='unknown', confidence=0.0,
    so the bot's classify node treats it as a fallthrough.
    """
    normalized = text.strip().lower()

    if _state.pipeline is None:
        return {
            "intent":             "unknown",
            "next_action":        "unknown",
            "tool":               None,
            "confidence":         0.0,
            "scores":             {},
            "normalized":         normalized,
            "classifier_version": "unloaded",
        }

    probas = _state.pipeline.predict_proba([normalized])[0]
    classes = list(_state.pipeline.classes_)
    top_idx = int(np.argmax(probas))
    top_intent = str(classes[top_idx])
    confidence = float(probas[top_idx])

    # Top-5 scores for transparency
    score_pairs = sorted(zip(classes, probas), key=lambda p: p[1], reverse=True)[:5]
    scores = {str(c): float(s) for c, s in score_pairs}

    meta = _state.intent_meta.get(top_intent, {})

    return {
        "intent":             top_intent,
        "next_action":        meta.get("next_action", "unknown"),
        "tool":               meta.get("tool"),
        "confidence":         confidence,
        "scores":             scores,
        "normalized":         normalized,
        "classifier_version": _state.version or "unknown",
    }
