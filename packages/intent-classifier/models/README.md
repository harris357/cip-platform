# Model artifacts

This directory holds joblib-pickled sklearn pipelines.

## Naming convention

`classifier-v<NN>-<YYYY-MM-DD>.joblib` — sortable by version.

The classifier loads the lexicographically-newest `*.joblib` at boot.

## Lifecycle

Model rev = image tag. To promote a new model:

1. `make classifier-train` — produces a fresh `.joblib` here
2. `make classifier-eval`  — verify it beats the prior artifact on held-out data
3. Commit the artifact + `make ship svc=intent-classifier` — CI builds the image with the new model baked in
4. `make deploy svc=intent-classifier TAG=<sha>` — pods restart with the new model

Rollback: `make deploy svc=intent-classifier TAG=<previous-sha>`.

## Bootstrap (no model yet)

The service runs in **degraded mode** if no `.joblib` is found here —
returns `intent=unknown, confidence=0.0` so the bot's classify graph
node treats it as a fallthrough. This lets the service ship before the
first model is trained.
