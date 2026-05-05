# Slice 56D — per-tenant intent-classifier models

Tenants with enough labelled data get their own classifier; everyone
else falls back to the platform-wide model from 56B.

## Decisions

| Q | A | Why |
|---|---|---|
| Schema | Add `tenant_id UUID NULL` to `bot_intent_model_runs`. Replace global `UNIQUE(model_version)` with two partial unique indexes: `(tenant_id, model_version)` for per-tenant + `(model_version) WHERE tenant_id IS NULL` for platform. | Keeps version names tenant-local (tenant A's `v20260504-0930` doesn't conflict with tenant B's). NULL = platform-wide, the back-compat default. |
| Min data per tenant | 50 reviewed rows AND ≥ 3 distinct intents | Below that, sklearn cross-val is meaningless. Trainer hard-rejects below; classifier service then keeps using platform model for that tenant. |
| Cache lifetime in service | Forever (per replica). 50 tenants × ~5MB pipeline = ~250MB; acceptable on the existing 256Mi limit if we bump to 512Mi. | LRU eviction + TTL adds bookkeeping for a problem we don't have at our scale yet. Documented limit; revisit at 100+ tenants. |
| Lazy vs eager per-tenant load | **Lazy** — first `/classify` for an unknown tenant kicks a one-shot S3 fetch of that tenant's `CURRENT.json`. 404 → fall back to platform. Found → load + cache + start polling. | Eager would waste boot time on tenants that may never call. Lazy keeps cold start fast. |
| Cron iterates tenants? | **No** in v1 | The cron entrypoint stays platform-only. Per-tenant retrain is operator-driven via `make classifier-retrain-now tenant=<id>`. Iterating in cron adds tenant-discovery + per-tenant skip-checks; ship the simpler version first. |
| Master switch | `CLASSIFIER_PER_TENANT_ENABLED` env on both service + trainer (set via Helm values, default `false`) | When `false`, /classify ignores tenant-specific models and the trainer rejects `--tenant-id`. Lets us ship the schema + code without enabling the feature in prod. |

## S3 layout

```
cip-platform-models/
  intent-classifier/
    CURRENT.json                        ← platform-wide pointer
    v20260504-1234.joblib               ← platform-wide artifact

    by-tenant/
      <tenant-uuid-A>/
        CURRENT.json                    ← tenant A pointer
        v20260504-1300.joblib
      <tenant-uuid-B>/
        CURRENT.json
        v20260503-2245.joblib
```

## Routing

```
POST /classify { text, tenant_id }

  if PER_TENANT_DISABLED:
    return platform.predict(text)

  if tenant_id in cache and cache[tenant_id] is loaded:
    return cache[tenant_id].predict(text)

  # Cache miss — try one-shot fetch (synchronous; ≤ 200ms typical)
  bundle = fetch_tenant_pointer(tenant_id)
  if bundle:
    cache[tenant_id] = load(bundle); start_polling(tenant_id)
    return cache[tenant_id].predict(text)

  # No tenant model — record negative cache so we don't refetch every request
  cache[tenant_id] = SENTINEL_NONE
  return platform.predict(text)
```

The negative-cache sentinel TTL is `MODEL_POLL_INTERVAL_SEC` so a
tenant whose model gets created later does eventually pick up.

## Files

| File | Change |
|---|---|
| `packages/hr-service/src/db/migrations/030_per_tenant_model_runs.sql` (new) | Add column + partial unique indexes. |
| `packages/hr-service/src/db/queries/bot-intent-training-data.ts` | `addModelRun` + `listModelRuns` + `latestModelRun` accept `tenantId?`. `countUntrainedSinceLatest` already had it. |
| `packages/intent-classifier/training/upload.py` | `record_model_run` + `record_membership` accept `tenant_id`. S3 keys use `by-tenant/<id>/` prefix when set. |
| `packages/intent-classifier/training/train.py` | New `--tenant-id` flag. Filters CSV by tenant column. Hard-rejects below thresholds. Names artifact `t-<id8>-v<date>` for log clarity. |
| `packages/intent-classifier/training/export_training_data.py` | (already has `--tenant-id`) — no change. |
| `packages/intent-classifier/src/classifier.py` | `_states: dict[str|None, _ModelState]`. `predict(text, tenant_id)` routes. `swap_in(bundle, version, tenant_id)`. |
| `packages/intent-classifier/src/s3_loader.py` | `fetch_pointer(tenant_id?)` reads tenant-scoped CURRENT. Multi-tenant poller manages a set of (tenant_id → loaded_version). New tenants registered on first /classify miss. |
| `packages/intent-classifier/src/main.py` | Pass `req.tenant_id` to `predict()`. |
| `packages/intent-classifier/helm/values.yaml` | `env.CLASSIFIER_PER_TENANT_ENABLED: "false"`. Memory bumped to 512Mi to accommodate cache. |
| `Makefile` | `classifier-retrain-now [tenant=<uuid>]` — adds optional tenant arg. |

## Tunables

None on the bot side. The classifier service is the gate; from the bot's
POV per-tenant routing is invisible (same /classify request, the service
internally decides which model to use).

## Out of scope

- Per-tenant cron iteration (v2)
- LRU eviction (only relevant at 100+ tenants)
- Cross-tenant model deprecation policy (when does the platform model
  override a stale per-tenant one?)
