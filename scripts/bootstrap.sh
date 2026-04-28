#!/usr/bin/env bash
set -euo pipefail

# App-layer bootstrap — idempotent, called automatically by 'make start'.
# Can also be run standalone after 'make bootstrap-infra'.
#
# Assumes:
#   - Infra pods (postgres, nats, keycloak) are Ready
#   - .envrc has been sourced (PG_USER_PASSWORD, KEYCLOAK_ADMIN_PASSWORD, etc.)

echo "=== CIP App Bootstrap ==="

# ── 1. Database migrations ────────────────────────────────────────────────────
echo "[1/5] Running database migrations..."
POSTGRES_POD=$(kubectl get pod -n cip-infra -l app.kubernetes.io/name=postgresql \
  -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")

if [[ -z "$POSTGRES_POD" ]]; then
  echo "      ERROR: postgres pod not found — ensure infra is running"
  exit 1
fi

# Create databases if they don't exist (idempotent — data persists on the PVC)
PG_ADMIN_PASS=$(kubectl get secret postgres-credentials -n cip-infra \
  -o jsonpath='{.data.postgres-password}' | base64 -d)
echo "      Ensuring databases exist..."
kubectl exec -n cip-infra "$POSTGRES_POD" -- \
  env PGPASSWORD="$PG_ADMIN_PASS" psql -U postgres \
  -c "CREATE DATABASE cip_hr OWNER cipuser;" \
  -c "CREATE DATABASE cip_litellm OWNER cipuser;" \
  2>&1 | grep -v "already exists" | sed 's/^/      /' || true

# pgvector must be created as superuser — cipuser cannot create extensions
kubectl exec -n cip-infra "$POSTGRES_POD" -- \
  env PGPASSWORD="$PG_ADMIN_PASS" psql -U postgres -d cip_hr \
  -c "CREATE EXTENSION IF NOT EXISTS vector;" 2>&1 | sed 's/^/      /' \
  || true

# Open a temporary port-forward on 15432 (avoids collision with 'make forward')
kubectl port-forward -n cip-infra svc/postgres-postgresql 15432:5432 &>/dev/null &
PF_PID=$!
sleep 3  # wait for the tunnel to be established

DATABASE_URL_HR="postgres://cipuser:${PG_USER_PASSWORD}@localhost:15432/cip_hr" \
  pnpm --filter @cip/hr-service run migrate

kill "$PF_PID" 2>/dev/null || true
echo "      Migrations done."

# ── 2+3. NATS KV bucket + JetStream streams ───────────────────────────────────
echo "[2/5] Creating NATS KV bucket for channel registry..."
echo "[3/5] Creating NATS JetStream streams..."
# The nats/nats image does not ship the nats CLI; use nats-box instead.
kubectl delete pod nats-setup -n cip-infra 2>/dev/null || true
kubectl run nats-setup --rm --restart=Never --attach --image=natsio/nats-box:latest \
  -n cip-infra -- sh -c '
    S=nats://nats:4222
    nats -s $S kv add teams-channel-registry --ttl=24h \
      && echo "KV bucket teams-channel-registry created." \
      || echo "KV bucket teams-channel-registry already exists (skipped)."
    for entry in \
      "CERTS|cip.*.certs.>|365d" \
      "HR_EVENTS|cip.*.hr.>|90d" \
      "PLATFORM_EVENTS|cip.*.platform.>|30d" \
      "HITL_EVENTS|cip.*.hitl.>|7d"; do
      name=$(echo "$entry" | cut -d"|" -f1)
      subjects=$(echo "$entry" | cut -d"|" -f2)
      retention=$(echo "$entry" | cut -d"|" -f3)
      nats -s $S stream info "$name" > /dev/null 2>&1 \
        && echo "Stream $name already exists (skipped)" \
        || nats -s $S stream add "$name" \
             --subjects "$subjects" \
             --storage file \
             --max-age "$retention" \
             --retention limits \
             --replicas 1 \
             --max-msgs -1 \
             --max-bytes -1 \
             --max-msg-size -1 \
             --discard old \
             --no-confirm \
             && echo "Created stream $name" \
             || echo "ERROR: failed to create stream $name"
    done
  ' 2>&1 | sed "s/^/      /"

# ── 4. Keycloak cip-dev realm ─────────────────────────────────────────────────
echo "[4/5] Creating Keycloak cip-dev realm..."
KC_POD=$(kubectl get pod -n cip-auth -l app.kubernetes.io/name=keycloak \
  --field-selector=status.phase=Running \
  -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")

if [[ -z "$KC_POD" ]]; then
  echo "      WARNING: Keycloak pod not running — skipping realm creation"
else
  # Use in-pod curl so bootstrap works regardless of external DNS/TLS setup
  KC_LOCAL="http://localhost:8080"
  KC_ADMIN_TOKEN=$(kubectl exec -n cip-auth "$KC_POD" -- \
    curl -sf -X POST \
    "${KC_LOCAL}/realms/master/protocol/openid-connect/token" \
    -d "client_id=admin-cli&username=admin&password=${KEYCLOAK_ADMIN_PASSWORD}&grant_type=password" \
    2>/dev/null | jq -r '.access_token' 2>/dev/null || echo "")

  if [[ -z "$KC_ADMIN_TOKEN" || "$KC_ADMIN_TOKEN" == "null" ]]; then
    echo "      WARNING: could not obtain Keycloak admin token — check KEYCLOAK_ADMIN_PASSWORD"
  else
    HTTP_STATUS=$(kubectl exec -n cip-auth "$KC_POD" -- \
      curl -sf -o /dev/null -w "%{http_code}" \
      -X POST "${KC_LOCAL}/admin/realms" \
      -H "Authorization: Bearer $KC_ADMIN_TOKEN" \
      -H "Content-Type: application/json" \
      -d '{"realm": "cip-dev", "enabled": true, "displayName": "CIP Dev"}' \
      2>/dev/null || echo "000")
    case "$HTTP_STATUS" in
      201) echo "      Realm cip-dev created." ;;
      409) echo "      Realm cip-dev already exists (skipped)." ;;
      *)   echo "      WARNING: Keycloak realm creation returned HTTP $HTTP_STATUS" ;;
    esac
  fi
fi

# ── 5. LiteLLM dev-tenant virtual key ────────────────────────────────────────
echo "[5/5] Issuing LiteLLM virtual key for dev tenant..."
LITELLM_POD=$(kubectl get pod -n cip-app -l app=litellm \
  --field-selector=status.phase=Running \
  -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")

if [[ -z "$LITELLM_POD" ]]; then
  echo "      WARNING: LiteLLM pod not running yet — skipping virtual key (re-run bootstrap after start completes)"
else
  # Read master key from secret so bootstrap works without sourcing .envrc
  _MASTER_KEY="${LITELLM_MASTER_KEY:-$(kubectl get secret litellm-credentials -n cip-app \
    -o jsonpath='{.data.LITELLM_MASTER_KEY}' 2>/dev/null | base64 -d 2>/dev/null || echo "")}"

  EXISTING_KEY=$(kubectl exec -n cip-app "$LITELLM_POD" -- \
    curl -sf http://localhost:4000/key/list \
    -H "Authorization: Bearer $_MASTER_KEY" \
    2>/dev/null | jq -r --arg alias "dev-tenant" '.keys[] | select(.key_alias==$alias) | .key' \
    2>/dev/null | head -1 || echo "")

  if [[ -n "$EXISTING_KEY" ]]; then
    echo "      Virtual key already exists (alias: dev-tenant)."
  else
    NEW_KEY=$(kubectl exec -n cip-app "$LITELLM_POD" -- \
      curl -sf -X POST http://localhost:4000/key/generate \
      -H "Authorization: Bearer $_MASTER_KEY" \
      -H "Content-Type: application/json" \
      -d "{\"key_alias\": \"dev-tenant\", \"team_id\": \"${DEV_TENANT_ID:-dev}\"}" \
      2>/dev/null | jq -r '.key' 2>/dev/null || echo "")

    if [[ -n "$NEW_KEY" && "$NEW_KEY" != "null" ]]; then
      echo "      Virtual key generated: $NEW_KEY"
      echo "      ACTION REQUIRED: add to .envrc → export LITELLM_VIRTUAL_KEY=$NEW_KEY"
    else
      echo "      WARNING: could not generate virtual key — check LITELLM_MASTER_KEY or LITELLM_DATABASE_URL"
    fi
  fi
fi

echo ""
echo "=== Bootstrap complete ==="
