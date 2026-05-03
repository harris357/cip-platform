"""Slice 56: FastAPI entrypoint for the intent-classifier service.

Endpoints:
  - POST /classify  → ClassifyResponse
  - GET  /healthz   → HealthResponse (kubernetes liveness + readiness)

Stateless. Multi-replica safe. Model loaded once at startup.
"""

from __future__ import annotations
import logging
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException

from .classifier import load_model, predict, is_loaded, get_state
from .schema import ClassifyRequest, ClassifyResponse, HealthResponse


logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("intent-classifier")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    load_model()
    yield
    # No teardown — model is in-memory only.


app = FastAPI(
    title="cip-intent-classifier",
    description="Slice 56: TF-IDF + LogReg intent classifier for the CIP teams-bot.",
    lifespan=lifespan,
)


@app.post("/classify", response_model=ClassifyResponse)
def classify(req: ClassifyRequest) -> dict:
    t0 = time.perf_counter()
    try:
        result = predict(req.text)
    except Exception as e:
        logger.exception("[classify] predict failed for request_id=%s", req.request_id)
        raise HTTPException(status_code=500, detail=f"predict failed: {e}")
    elapsed_ms = int((time.perf_counter() - t0) * 1000)
    logger.info(
        "[classify] request_id=%s tenant=%s intent=%s confidence=%.3f elapsed_ms=%d",
        req.request_id, req.tenant_id, result["intent"], result["confidence"], elapsed_ms,
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
