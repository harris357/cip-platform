# Slice 56: intent-classifier service.
#
# CPU-only sklearn TfidfVectorizer + LogisticRegression behind FastAPI.
# Model artifact baked into the image at build time — model rev = image tag.
#
# Single-stage: classifier user owns site-packages so non-root can run.
# (Multi-stage with --user installs broke because /root/.local was 700.)

FROM python:3.12-slim

# Non-root runtime user (must exist before pip install --user)
RUN useradd --create-home --uid 1000 classifier

WORKDIR /app

COPY packages/intent-classifier/requirements.txt ./

# Install as the runtime user so site-packages are readable by it.
USER classifier
ENV PATH=/home/classifier/.local/bin:$PATH
RUN pip install --no-cache-dir --user -r requirements.txt

# Source + model artifact (artifact baked in — model rev = image tag).
# COPY paths are root-relative because CI uses `context: .` (repo root).
USER root
COPY packages/intent-classifier/src/    ./src/
COPY packages/intent-classifier/models/ ./models/
RUN chown -R classifier:classifier /app
USER classifier

EXPOSE 8000

# uvicorn with a single worker — the model is in-memory and stateless,
# replicas come from k8s, not from worker processes.
CMD ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "8000", "--log-level", "info"]
