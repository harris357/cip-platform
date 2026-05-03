# Slice 56: intent-classifier service.
#
# CPU-only sklearn TfidfVectorizer + LogisticRegression behind FastAPI.
# Model artifact baked into the image at build time — model rev = image tag.
# Two stages: builder installs deps + tests; final ships only what's needed.

# ── Builder ─────────────────────────────────────────────────────────────────
FROM python:3.12-slim AS builder

WORKDIR /build

# System deps (sklearn wheels are pure-python on amd64; nothing extra needed)
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY packages/intent-classifier/requirements.txt ./
RUN pip install --no-cache-dir --user -r requirements.txt

# ── Runtime ─────────────────────────────────────────────────────────────────
FROM python:3.12-slim

WORKDIR /app

# Copy installed packages from builder
COPY --from=builder /root/.local /root/.local
ENV PATH=/root/.local/bin:$PATH

# Source + model artifact (artifact baked in — model rev = image tag).
# Note: build context is repo root (see build-and-push.yaml `context: .`),
# so paths are root-relative.
COPY packages/intent-classifier/src/    ./src/
COPY packages/intent-classifier/models/ ./models/

# Non-root for runtime safety
RUN useradd --no-create-home --uid 1000 classifier && chown -R classifier:classifier /app
USER classifier

EXPOSE 8000

# uvicorn with a single worker — the model is in-memory and stateless,
# replicas come from k8s, not from worker processes.
CMD ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "8000", "--log-level", "info"]
