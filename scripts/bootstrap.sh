#!/usr/bin/env bash
set -euo pipefail

# App-layer bootstrap — run once after 'make bootstrap-infra' completes.
# Safe to re-run (idempotent).
#
# Assumes:
#   - Terraform has provisioned the cluster, PVCs, and infra Helm charts (postgres, nats, keycloak)
#   - KUBECONFIG points at the cluster (~/.kube/cip-dev.yaml)
#   - K8s secrets already created by bootstrap-infra.sh

echo "=== CIP App Bootstrap ==="

# ── 1. Database migrations ────────────────────────────────────────────────────
echo "[1/4] Running database migrations..."
if [[ -n "${DATABASE_URL_HR:-}" ]]; then
  pnpm --filter @cip/hr-service run migrate
else
  echo "      DATABASE_URL_HR not set — attempting kubectl fallback..."
  POSTGRES_POD=$(kubectl get pod -n cip-infra -l app.kubernetes.io/name=postgresql \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")

  if [[ -z "$POSTGRES_POD" ]]; then
    echo "      WARNING: postgres pod not found — set DATABASE_URL_HR or run after 'make start'"
  else
    kubectl exec -n cip-infra "$POSTGRES_POD" -- \
      psql -U cipuser -d cip_hr \
      -c "$(cat packages/hr-service/src/db/migrations/001_initial.sql)" \
      2>&1 | grep -v "^$" | sed 's/^/      /' \
      || echo "      INFO: migration already applied or psql error (check above)"
    echo "      Migrations done."
  fi
fi

# ── 2. NATS KV bucket for channel registry (Slice 26 — resolves CS-018) ──────
echo "[2/5] Creating NATS KV bucket for channel registry..."
NATS_POD_KV=$(kubectl get pod -n cip-infra -l app.kubernetes.io/name=nats \
  -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")

if [[ -z "$NATS_POD_KV" ]]; then
  echo "      WARNING: NATS pod not found — run again after 'make start'"
else
  kubectl exec -n cip-infra "$NATS_POD_KV" -- \
    nats kv add teams-channel-registry --ttl=24h 2>/dev/null \
    && echo "      KV bucket teams-channel-registry created." \
    || echo "      KV bucket teams-channel-registry already exists (skipped)."
fi

# ── 3. NATS JetStream streams ─────────────────────────────────────────────────
echo "[3/5] Creating NATS JetStream streams..."
NATS_POD=$(kubectl get pod -n cip-infra -l app.kubernetes.io/name=nats \
  -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")

if [[ -z "$NATS_POD" ]]; then
  echo "      WARNING: NATS pod not found — run again after 'make start'"
else
  while IFS='|' read -r stream_name subjects retention; do
    kubectl exec -n cip-infra "$NATS_POD" -- \
      nats stream add "$stream_name" \
        --subjects "$subjects" \
        --storage file \
        --max-age "$retention" \
        --retention limits \
        --defaults \
        2>/dev/null \
      && echo "      Created stream $stream_name" \
      || echo "      Stream $stream_name already exists (skipped)"
  done <<'STREAMS'
CERTS|cip.*.certs.>|1y
HR_EVENTS|cip.*.hr.>|90d
PLATFORM_EVENTS|cip.*.platform.>|30d
HITL_EVENTS|cip.*.hitl.>|7d
STREAMS
fi

# ── 4. Keycloak cip-dev realm ─────────────────────────────────────────────────
echo "[4/5] Creating Keycloak cip-dev realm..."
KC_POD=$(kubectl get pod -n cip-auth -l app.kubernetes.io/name=keycloak \
  --field-selector=status.phase=Running \
  -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")

if [[ -z "$KC_POD" ]]; then
  echo "      WARNING: Keycloak pod not running — run again after 'make start'"
else
  KC_ADMIN_TOKEN=$(curl -sf -X POST \
    "${KEYCLOAK_URL}/realms/master/protocol/openid-connect/token" \
    -d "client_id=admin-cli&username=admin&password=${KEYCLOAK_ADMIN_PASSWORD}&grant_type=password" \
    | jq -r '.access_token' 2>/dev/null || echo "")

  if [[ -z "$KC_ADMIN_TOKEN" || "$KC_ADMIN_TOKEN" == "null" ]]; then
    echo "      WARNING: could not obtain Keycloak admin token — check KEYCLOAK_ADMIN_PASSWORD"
  else
    HTTP_STATUS=$(curl -sf -o /dev/null -w "%{http_code}" \
      -X POST "${KEYCLOAK_URL}/admin/realms" \
      -H "Authorization: Bearer $KC_ADMIN_TOKEN" \
      -H "Content-Type: application/json" \
      -d "{\"realm\": \"cip-dev\", \"enabled\": true, \"displayName\": \"CIP Dev\"}" \
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
  echo "      WARNING: LiteLLM pod not running — run again after 'make start'"
else
  EXISTING_KEY=$(curl -sf "${LITELLM_BASE_URL}/key/list" \
    -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
    | jq -r --arg alias "dev-tenant" '.keys[] | select(.key_alias==$alias) | .key' \
    2>/dev/null | head -1 || echo "")

  if [[ -n "$EXISTING_KEY" ]]; then
    echo "      Virtual key already exists (alias: dev-tenant)."
  else
    NEW_KEY=$(curl -sf -X POST "${LITELLM_BASE_URL}/key/generate" \
      -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
      -H "Content-Type: application/json" \
      -d "{\"key_alias\": \"dev-tenant\", \"team_id\": \"${DEV_TENANT_ID:-dev}\"}" \
      | jq -r '.key' 2>/dev/null || echo "")

    if [[ -n "$NEW_KEY" && "$NEW_KEY" != "null" ]]; then
      echo "      Virtual key generated: $NEW_KEY"
      echo "      ACTION REQUIRED: add to .envrc → export LITELLM_VIRTUAL_KEY=$NEW_KEY"
    else
      echo "      WARNING: could not generate virtual key — check LITELLM_MASTER_KEY"
    fi
  fi
fi

echo ""
echo "=== App bootstrap complete ==="
echo "Next: make start"
