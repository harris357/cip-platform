"""Slice 56 + 56B: FastAPI entrypoint for the intent-classifier service.

Endpoints:
  - POST /classify  → ClassifyResponse
  - GET  /healthz   → HealthResponse (kubernetes liveness + readiness)

Stateless w.r.t. requests; statefully loads + hot-reloads the model.
Multi-replica safe — every replica polls S3 independently and converges
on the same artifact within MODEL_POLL_INTERVAL_SEC of upload.

Slice 56B: model loading is now two-phase:
  1. lifespan boot loads the image-baked baseline (if any).
  2. S3ModelLoader starts a background asyncio task that polls
     s3://$MODEL_S3_BUCKET/$MODEL_S3_PREFIX/CURRENT.json and swaps in
     a newer artifact via classifier.swap_in() when the version differs.
"""

from __future__ import annotations
import logging
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException

from .classifier import (
    load_model, predict, is_loaded, get_state, swap_in, set_loader,
    PER_TENANT_ENABLED,
)
from .schema import ClassifyRequest, ClassifyResponse, HealthResponse
from .s3_loader import S3ModelLoader


logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("intent-classifier")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Phase 1: image-baked baseline (best-effort).
    load_model()

    # Phase 2: S3 hot-reload poller. Tells the poller our currently-loaded
    # version so it skips the redundant swap if the baseline already
    # matches the S3 CURRENT pointer.
    loader = S3ModelLoader(on_swap=swap_in)
    state = get_state()
    loader.set_loaded_version(state.version, tenant_id=None)
    # Slice 56D: classifier.predict() needs the loader for lazy
    # per-tenant registration on cache miss.
    set_loader(loader)
    await loader.start()
    logger.info(
        "[main] S3 poller started (loaded baseline=%s per_tenant=%s)",
        state.version, PER_TENANT_ENABLED,
    )

    try:
        yield
    finally:
        await loader.stop()
        # No model teardown — process exit reaps the in-memory state.


app = FastAPI(
    title="cip-intent-classifier",
    description="Slice 56: TF-IDF + LogReg intent classifier for the CIP teams-bot.",
    lifespan=lifespan,
)


@app.post("/classify", response_model=ClassifyResponse)
async def classify(req: ClassifyRequest) -> dict:
    # Slice 56D: async because predict() may need to lazy-register a
    # tenant model on cache miss (synchronous /classify can't await).
    t0 = time.perf_counter()
    try:
        result = await predict(req.text, req.tenant_id)
    except Exception as e:
        logger.exception("[classify] predict failed for request_id=%s", req.request_id)
        raise HTTPException(status_code=500, detail=f"predict failed: {e}")
    elapsed_ms = int((time.perf_counter() - t0) * 1000)
    logger.info(
        "[classify] request_id=%s tenant=%s intent=%s confidence=%.3f version=%s elapsed_ms=%d",
        req.request_id, req.tenant_id, result["intent"], result["confidence"],
        result["classifier_version"], elapsed_ms,
    )
    return result


@app.get("/healthz", response_model=HealthResponse)
def healthz() -> dict:
    state = get_state()
    return {
        "ok":            is_loaded(),
        "model_version": state.version,
        "intents_count": len(state.intents),
        "loaded_at":     state.loaded_at.isoformat() if state.loaded_at else None,
    }
