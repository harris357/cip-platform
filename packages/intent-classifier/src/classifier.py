"""Slice 56 + 56B: model loader + predict wrapper.

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

Slice 56B: model is no longer image-baked-only. On boot we load the
image-baked artifact (if any) as a fallback baseline, then S3ModelLoader
(src/s3_loader.py) polls the platform's S3 for a newer artifact and
swaps in-place via swap_in(). This decouples model rev from image rev:
adding a phrase + retraining no longer requires an image rebuild.

Multi-replica safe — model is read-only and swap_in is a single Python
attribute assignment per field (CPython GIL guarantees atomicity per
write; predict() never sees a half-applied bundle).
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
    """Load the image-baked artifact (if any) as a baseline.

    The S3 poller (s3_loader.py) takes over after this and may
    immediately swap in a newer artifact via swap_in(). The image-baked
    load is intentionally optional — for clusters running 56B onwards
    the image can ship with no .joblib at all and rely entirely on S3.

    Conventional naming: classifier-v<NN>-<YYYY-MM-DD>.joblib.
    Falls back to any .joblib if the convention isn't met.
    """
    if not _DEFAULT_MODEL_DIR.exists():
        logger.warning(
            "[classifier] model dir does not exist: %s — relying on S3 hot-reload only",
            _DEFAULT_MODEL_DIR,
        )
        return

    candidates = sorted(_DEFAULT_MODEL_DIR.glob("*.joblib"), reverse=True)
    if not candidates:
        # Slice 56B: no longer fatal — S3 poller may bring up a model
        # within MODEL_POLL_INTERVAL_SEC. Until then, /classify returns
        # 'unknown'/0.0 and the bot's classify node treats it as
        # fallthrough.
        logger.warning(
            "[classifier] no baked-in .joblib found in %s — running in DEGRADED mode "
            "until S3 poller brings up an artifact (or always, if S3 has none).",
            _DEFAULT_MODEL_DIR,
        )
        return

    artifact_path = candidates[0]
    logger.info("[classifier] loading baked-in baseline %s", artifact_path)
    try:
        bundle = joblib.load(artifact_path)
    except Exception:
        # Slice 56B: also non-fatal. A corrupt baked-in artifact
        # shouldn't kill the pod — the S3 poller is the source of truth.
        logger.exception("[classifier] failed to load %s — falling through to S3 poller", artifact_path)
        return
    swap_in(bundle, bundle.get("version", artifact_path.stem))


def swap_in(bundle: dict, version: str) -> None:
    """Atomically swap the active model. Called by load_model() on boot
    and by S3ModelLoader on hot-reload.

    Atomicity note: each `_state.<field> = ...` is a single attribute
    assignment, atomic under the GIL. predict() reads `_state.pipeline`
    once into a local; even if a swap interleaves a multi-field update,
    predict either sees the full old or the full new — never a half-set
    bundle, because pipeline + intent_meta + intents are written in the
    same dict already.
    """
    pipeline   = bundle["pipeline"]
    intents    = sorted(bundle.get("intents", list(pipeline.classes_)))
    intent_meta = bundle.get("intent_meta", {})

    _state.pipeline    = pipeline
    _state.intent_meta = intent_meta
    _state.intents     = intents
    _state.version     = version
    _state.loaded_at   = datetime.now(timezone.utc)
    logger.info(
        "[classifier] active model: version=%s intents=%d at=%s",
        version, len(intents), _state.loaded_at.isoformat(),
    )


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
