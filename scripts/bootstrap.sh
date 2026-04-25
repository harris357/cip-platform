#!/usr/bin/env bash
set -euo pipefail

# Bootstrap — run once after cluster creation. Safe to re-run (idempotent).
# Order matters: namespaces → PVCs → secrets → Helm → app config

echo "=== CIP Bootstrap ==="

# 1. Namespaces first — PVCs depend on them
echo "[1/6] Applying namespaces..."
kubectl apply -f infra/k8s/namespaces.yaml

# 2. PVCs — creates the two Cinder volumes in OVH. NEVER delete these.
echo "[2/6] Applying PVCs (postgres-pvc, nats-pvc)..."
kubectl apply -f infra/k8s/pvcs.yaml
echo "      Waiting for PVCs to bind..."
kubectl wait --for=condition=Bound pvc/postgres-pvc -n cip-infra --timeout=120s
kubectl wait --for=condition=Bound pvc/nats-pvc     -n cip-infra --timeout=120s
echo "      PVCs bound. Cinder volumes created in OVH."

# 3. Secrets — must exist before Helm install reads them
echo "[3/6] Creating K8s secrets..."
bash scripts/create-secrets.sh

# 4. Helm — infrastructure services
echo "[4/6] Installing infrastructure Helm charts..."
helm repo add bitnami https://charts.bitnami.com/bitnami
helm repo add nats https://nats-io.github.io/k8s/helm/charts
helm repo update

helm upgrade --install postgres bitnami/postgresql \
  -n cip-infra -f infra/helm/postgres-values.yaml --wait

helm upgrade --install nats nats/nats \
  -n cip-infra -f infra/helm/nats-values.yaml --wait

# 5. Apply LiteLLM config
echo "[5/6] Applying LiteLLM ConfigMap..."
kubectl apply -f infra/k8s/litellm-config.yaml

# 6. Database migrations
echo "[6/9] Running database migrations..."
POSTGRES_POD=$(kubectl get pod -n cip-infra -l app.kubernetes.io/name=postgresql \
  -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")

if [[ -z "$POSTGRES_POD" ]]; then
  echo "      WARNING: postgres pod not found — skipping migrations (run again after make start)"
else
  kubectl exec -n cip-infra "$POSTGRES_POD" -- \
    psql -U cipuser -d cip_hr -c "SELECT 1" &>/dev/null 2>&1 \
    && kubectl exec -n cip-infra "$POSTGRES_POD" -- \
         psql -U cipuser -d cip_hr \
         -c "$(cat packages/hr-service/src/db/migrations/001_initial.sql 2>/dev/null || echo 'SELECT 1')" \
    || echo "      WARNING: migration skipped or already applied"
  echo "      Migrations done."
fi

# 7. NATS streams — idempotent (add fails silently if stream exists)
echo "[7/9] Creating NATS JetStream streams..."
NATS_POD=$(kubectl get pod -n cip-infra -l app.kubernetes.io/name=nats \
  -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")

if [[ -z "$NATS_POD" ]]; then
  echo "      WARNING: NATS pod not found — skipping stream creation (run again after make start)"
else
  # Create each stream; --force flag skips prompt; exit 0 if already exists
  for stream_def in \
    "CERTS|cip.*.certs.>|1y" \
    "HR_EVENTS|cip.*.hr.>|90d" \
    "PLATFORM_EVENTS|cip.*.platform.>|30d" \
    "HITL_EVENTS|cip.*.hitl.>|7d"; do

    IFS='|' read -r stream_name subjects retention <<< "$stream_def"
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
  done
fi

# 8. Keycloak cip-master realm — idempotent (409 = already exists)
echo "[8/9] Creating Keycloak cip-master realm..."
KC_READY=$(kubectl get pod -n cip-auth -l app.kubernetes.io/name=keycloak \
  --field-selector=status.phase=Running \
  -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")

if [[ -z "$KC_READY" ]]; then
  echo "      WARNING: Keycloak pod not running — skipping realm creation (run again after make start)"
else
  KC_ADMIN_TOKEN=$(curl -sf -X POST \
    "${KEYCLOAK_URL}/realms/master/protocol/openid-connect/token" \
    -d "client_id=admin-cli&username=admin&password=${KEYCLOAK_ADMIN_PASSWORD}&grant_type=password" \
    | jq -r '.access_token' 2>/dev/null || echo "")

  if [[ -z "$KC_ADMIN_TOKEN" ]] || [[ "$KC_ADMIN_TOKEN" == "null" ]]; then
    echo "      WARNING: could not obtain Keycloak admin token — skipping realm creation"
  else
    HTTP_STATUS=$(curl -sf -o /dev/null -w "%{http_code}" \
      -X POST "${KEYCLOAK_URL}/admin/realms" \
      -H "Authorization: Bearer $KC_ADMIN_TOKEN" \
      -H "Content-Type: application/json" \
      -d "{\"realm\": \"cip-master\", \"enabled\": true, \"displayName\": \"CIP Master\"}" \
      2>/dev/null || echo "000")
    case "$HTTP_STATUS" in
      201) echo "      Realm cip-master created." ;;
      409) echo "      Realm cip-master already exists (skipped)." ;;
      *)   echo "      WARNING: Keycloak realm creation returned HTTP $HTTP_STATUS" ;;
    esac
  fi
fi

# 9. LiteLLM dev tenant virtual key — idempotent (check alias before creating)
echo "[9/9] Issuing LiteLLM virtual key for dev tenant..."
LITELLM_READY=$(kubectl get pod -n cip-app -l app=litellm \
  --field-selector=status.phase=Running \
  -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")

if [[ -z "$LITELLM_READY" ]]; then
  echo "      WARNING: LiteLLM pod not running — skipping virtual key (run again after make start)"
else
  EXISTING_KEY=$(curl -sf "${LITELLM_BASE_URL}/key/list" \
    -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
    | jq -r --arg alias "dev-tenant" '.keys[] | select(.key_alias==$alias) | .key' \
    2>/dev/null | head -1 || echo "")

  if [[ -n "$EXISTING_KEY" ]]; then
    echo "      Dev tenant virtual key already exists (alias: dev-tenant)."
    echo "      Ensure LITELLM_VIRTUAL_KEY in .envrc starts with: ${EXISTING_KEY:0:8}..."
  else
    NEW_KEY=$(curl -sf -X POST "${LITELLM_BASE_URL}/key/generate" \
      -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
      -H "Content-Type: application/json" \
      -d "{\"key_alias\": \"dev-tenant\", \"team_id\": \"${DEV_TENANT_ID:-dev}\"}" \
      | jq -r '.key' 2>/dev/null || echo "")

    if [[ -n "$NEW_KEY" ]] && [[ "$NEW_KEY" != "null" ]]; then
      echo "      Virtual key generated: $NEW_KEY"
      echo "      ACTION REQUIRED: add to .envrc → export LITELLM_VIRTUAL_KEY=$NEW_KEY"
    else
      echo "      WARNING: could not generate virtual key — check LITELLM_MASTER_KEY and LITELLM_BASE_URL"
    fi
  fi
fi

echo ""
echo "=== Bootstrap complete ==="
echo "PVCs (Cinder volumes) are now bound and will persist across node restarts."
echo "Next: make start"
