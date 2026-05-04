"""Slice 56 + 56B + 56D: model loader + predict wrapper.

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

Slice 56D: per-tenant model support. _states is now keyed by tenant_id
(None = platform). predict(text, tenant_id) routes:
  1. If per-tenant disabled (env), use platform.
  2. If tenant has a loaded model, use it.
  3. Else, ask S3ModelLoader to register + lazy-fetch the tenant model.
     If found, use it. If not, fall back to platform.

Multi-replica safe — model dicts are read-only and swap_in is a single
Python attribute assignment per field.
"""

from __future__ import annotations
import logging
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import joblib
import numpy as np

logger = logging.getLogger("intent-classifier")

# Default location — Dockerfile copies models/ into /app/models/.
# Override via INTENT_CLASSIFIER_MODEL_PATH for local dev or testing.
_DEFAULT_MODEL_DIR = Path(os.environ.get("INTENT_CLASSIFIER_MODEL_PATH", "/app/models"))

PER_TENANT_ENABLED = os.environ.get("CLASSIFIER_PER_TENANT_ENABLED", "false").lower() == "true"


class _ModelState:
    def __init__(self) -> None:
        self.pipeline = None        # sklearn.pipeline.Pipeline
        self.intents: list[str] = []
        self.intent_meta: dict[str, dict[str, str]] = {}
        self.version: Optional[str] = None
        self.loaded_at: Optional[datetime] = None


# Slice 56D: keyed by tenant_id (None = platform). Always has a None
# entry; per-tenant entries appear when swap_in fires for them.
_states: dict[Optional[str], _ModelState] = {None: _ModelState()}

# Slice 56D: hook the S3 loader sets at startup. The classify path
# uses it for lazy per-tenant registration on cache miss.
_loader = None  # set by main.py after S3ModelLoader instantiation


def set_loader(loader) -> None:
    """Called from main.py to wire the lazy-register path. Decouples
    classifier.py from the loader's import to avoid cycles."""
    global _loader
    _loader = loader


def load_model() -> None:
    """Load the image-baked artifact (if any) as the platform baseline.

    The S3 poller (s3_loader.py) takes over after this and may
    immediately swap in a newer artifact via swap_in(). The image-baked
    load is intentionally optional — for clusters running 56B+ the image
    can ship with no .joblib at all and rely entirely on S3.

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
    swap_in(bundle, bundle.get("version", artifact_path.stem), tenant_id=None)


def swap_in(bundle: dict, version: str, tenant_id: Optional[str] = None) -> None:
    """Atomically swap the active model for a scope. Called by load_model()
    on boot and by S3ModelLoader on hot-reload.

    Atomicity note: each `state.<field> = ...` is a single attribute
    assignment, atomic under the GIL. predict() reads `state.pipeline`
    once into a local; even if a swap interleaves a multi-field update,
    predict either sees the full old or the full new — never a half-set
    bundle, because pipeline + intent_meta + intents are written in the
    same dict already.

    Slice 56D: tenant_id keys the per-scope state. tenant_id=None is
    the platform baseline; UUID is per-tenant.
    """
    pipeline    = bundle["pipeline"]
    intents     = sorted(bundle.get("intents", list(pipeline.classes_)))
    intent_meta = bundle.get("intent_meta", {})

    state = _states.get(tenant_id)
    if state is None:
        state = _ModelState()
        _states[tenant_id] = state

    state.pipeline    = pipeline
    state.intent_meta = intent_meta
    state.intents     = intents
    state.version     = version
    state.loaded_at   = datetime.now(timezone.utc)
    logger.info(
        "[classifier] active model: scope=%s version=%s intents=%d at=%s",
        tenant_id or "platform", version, len(intents), state.loaded_at.isoformat(),
    )


def is_loaded() -> bool:
    """True iff the platform baseline is loaded. /healthz uses this."""
    return _states[None].pipeline is not None


def get_state(tenant_id: Optional[str] = None) -> _ModelState:
    return _states.get(tenant_id) or _states[None]


def get_all_states() -> dict[Optional[str], _ModelState]:
    """Snapshot of every loaded scope. /healthz uses this when
    PER_TENANT_ENABLED is true."""
    return dict(_states)


async def predict(text: str, tenant_id: Optional[str] = None) -> dict:
    """Return the classifier's prediction for `text` in the given scope.

    Routing (Slice 56D):
      1. If per-tenant is disabled, always use the platform model.
      2. If tenant_id has a loaded model in cache, use it.
      3. Else, ask the loader to register + lazy-fetch this tenant.
         If a model loads, use it; otherwise fall back to platform.

    Always returns a dict matching schema.ClassifyResponse — degraded
    mode (no model loaded for the scope) returns intent='unknown',
    confidence=0.0 so the bot's classify node treats it as a fallthrough.
    """
    normalized = text.strip().lower()

    chosen: _ModelState = _states[None]
    used_tenant_model = False
    if PER_TENANT_ENABLED and tenant_id:
        existing = _states.get(tenant_id)
        if existing is not None and existing.pipeline is not None:
            chosen = existing
            used_tenant_model = True
        elif _loader is not None:
            # Lazy register — synchronous wrt this request, but the actual
            # download runs in an executor so the event loop isn't blocked.
            try:
                ok = await _loader.register_tenant(tenant_id)
                if ok:
                    chosen = _states.get(tenant_id) or chosen
                    used_tenant_model = chosen is not _states[None]
            except Exception:
                logger.exception("[classifier] lazy register_tenant failed for %s — using platform", tenant_id)

    if chosen.pipeline is None:
        return {
            "intent":             "unknown",
            "next_action":        "unknown",
            "tool":               None,
            "confidence":         0.0,
            "scores":             {},
            "normalized":         normalized,
            "classifier_version": "unloaded",
        }

    probas = chosen.pipeline.predict_proba([normalized])[0]
    classes = list(chosen.pipeline.classes_)
    top_idx = int(np.argmax(probas))
    top_intent = str(classes[top_idx])
    confidence = float(probas[top_idx])

    # Top-5 scores for transparency
    score_pairs = sorted(zip(classes, probas), key=lambda p: p[1], reverse=True)[:5]
    scores = {str(c): float(s) for c, s in score_pairs}

    meta = chosen.intent_meta.get(top_intent, {})

    # Suffix the version with a scope tag so /turn footer / debug can
    # see at-a-glance which model handled the call.
    version_with_scope = (
        f"{chosen.version}@tenant" if used_tenant_model
        else f"{chosen.version}@platform" if chosen.version else "unknown"
    )

    return {
        "intent":             top_intent,
        "next_action":        meta.get("next_action", "unknown"),
        "tool":               meta.get("tool"),
        "confidence":         confidence,
        "scores":             scores,
        "normalized":         normalized,
        "classifier_version": version_with_scope,
    }
