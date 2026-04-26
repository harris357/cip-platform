#!/usr/bin/env bash
set -euo pipefail

# One-time infrastructure provisioning via Terraform.
# Run from repo root with .envrc sourced.
# Order: bootstrap/ (cluster + buckets) → write kubeconfig → cluster/ (node pool + infra charts) → K8s secrets

echo "=== CIP Infrastructure Bootstrap ==="

# Map .envrc OVH_* names to Terraform TF_VAR_* names
export TF_VAR_ovh_endpoint="${OVH_ENDPOINT:-ovh-ca}"
export TF_VAR_ovh_application_key="$OVH_APP_KEY"
export TF_VAR_ovh_application_secret="$OVH_APP_SECRET"
export TF_VAR_ovh_consumer_key="$OVH_CONSUMER_KEY"
export TF_VAR_ovh_cloud_project_service="$OVH_PROJECT_ID"

# Private network UUID — OVH Console → Public Cloud → Network → Private Networks → Network ID column
if [[ -z "${OVH_PRIVATE_NETWORK_ID:-}" ]]; then
  echo "ERROR: OVH_PRIVATE_NETWORK_ID is not set."
  echo "  Find it: OVH Console → Public Cloud → Network → Private Networks → Network ID column"
  echo "  Then add to .envrc: export OVH_PRIVATE_NETWORK_ID=<uuid>"
  exit 1
fi
export TF_VAR_private_network_id="$OVH_PRIVATE_NETWORK_ID"

# ── Step 1: bootstrap/ — provision OVH cluster + Object Store buckets ────────
echo ""
echo "[1/4] Terraform bootstrap/ — cluster + object store buckets..."
terraform -chdir=infra/terraform/bootstrap init -input=false -upgrade
terraform -chdir=infra/terraform/bootstrap apply -input=false -auto-approve

# ── Step 2: Write kubeconfig from Terraform output ───────────────────────────
echo ""
echo "[2/4] Writing kubeconfig to ~/.kube/cip-dev.yaml..."
mkdir -p ~/.kube
terraform -chdir=infra/terraform/bootstrap output -raw kubeconfig > ~/.kube/cip-dev.yaml
chmod 600 ~/.kube/cip-dev.yaml
export KUBECONFIG=~/.kube/cip-dev.yaml
echo "      Cluster reachable: $(kubectl cluster-info --request-timeout=10s 2>&1 | head -1)"

# ── Step 3: cluster/ — node pool + infra Helm charts ─────────────────────────
# Read cluster ID from bootstrap output — do not rely on OVH_CLUSTER_ID being set
CLUSTER_ID=$(terraform -chdir=infra/terraform/bootstrap output -raw cluster_id)
export TF_VAR_cluster_id="$CLUSTER_ID"

echo ""
echo "[3/4] Terraform cluster/ — node pool + infra Helm charts (postgres, nats, keycloak, monitoring)..."
echo "      Cluster ID: $CLUSTER_ID"
terraform -chdir=infra/terraform/cluster init -input=false -upgrade
terraform -chdir=infra/terraform/cluster apply -input=false -auto-approve

# ── Step 4: K8s secrets ───────────────────────────────────────────────────────
echo ""
echo "[4/5] Creating K8s secrets..."
bash scripts/create-secrets.sh

# ── Step 5: DNS + TLS ─────────────────────────────────────────────────────────
echo ""
echo "[5/5] Waiting for ingress-nginx LoadBalancer IP (OVH Floating IP)..."
echo "      This can take 1-2 minutes after cluster/ apply..."

LB_IP=""
for i in $(seq 1 24); do
  LB_IP=$(kubectl get svc -n ingress-nginx ingress-nginx-controller \
    -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || echo "")
  if [[ -n "$LB_IP" ]]; then break; fi
  echo "      [$i/24] waiting... (${i}0s)"
  sleep 10
done

if [[ -n "$LB_IP" ]]; then
  echo "      LoadBalancer IP: $LB_IP"
  export OVH_LB_IP="$LB_IP"
  bash scripts/configure-dns.sh
  bash scripts/configure-tls.sh
else
  echo "      WARNING: LB IP not yet assigned — run these manually once it appears:"
  echo "        kubectl get svc -n ingress-nginx ingress-nginx-controller"
  echo "        make configure-dns"
  echo "        make configure-tls"
fi

echo ""
echo "=== Infrastructure ready ==="
echo "Add to .envrc:"
echo "  export OVH_CLUSTER_ID=$CLUSTER_ID"
[[ -n "$LB_IP" ]] && echo "  export OVH_LB_IP=$LB_IP"
echo ""
echo "Next: make bootstrap"
echo "  (NATS streams, Keycloak realm, DB migrations, LiteLLM virtual key)"
