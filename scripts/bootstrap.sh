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
echo "[6/6] Running database migrations..."
# TODO: kubectl exec into postgres pod and run 001_initial.sql
# kubectl exec -n cip-infra deploy/postgres-postgresql -- psql -U cipuser -d cip_hr \
#   -f /dev/stdin < packages/hr-service/src/db/migrations/001_initial.sql

echo ""
echo "=== Bootstrap complete ==="
echo "PVCs (Cinder volumes) are now bound and will persist across node restarts."
echo "Next: make start"
