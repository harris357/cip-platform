#!/usr/bin/env bash
set -euo pipefail

# One-time infrastructure provisioning via Terraform.
# Run from repo root with .envrc sourced.
# Order: bootstrap/ (cluster + buckets) → write kubeconfig → cluster/ (node pool + infra charts) → K8s secrets

echo "=== CIP Infrastructure Bootstrap ==="

# ── Step 0: OpenStack security group — restrict ingress to Cloudflare IPs ────
echo ""
echo "[0] OpenStack — cloudflare-only security group..."
export OS_AUTH_URL="https://auth.cloud.ovh.net/v3"
export OS_IDENTITY_API_VERSION=3
export OS_USER_DOMAIN_NAME="Default"
export OS_PROJECT_DOMAIN_NAME="Default"
export OS_PROJECT_ID="${OVH_PROJECT_ID}"
export OS_USERNAME="${OPENSTACK_USER}"
export OS_PASSWORD="${OPENSTACK_PASSWORD}"
export OS_REGION_NAME="${OVH_REGION:-BHS5}"

if ! openstack security group show cloudflare-only &>/dev/null; then
  openstack security group create cloudflare-only --description "Allow Cloudflare IPs only"
  # SSH
  openstack security group rule create --protocol tcp --dst-port 22 --remote-ip 0.0.0.0/0 cloudflare-only
  # Cloudflare IPv4 ranges — https://www.cloudflare.com/ips-v4
  for CIDR in \
    103.21.244.0/22 103.22.200.0/22 103.31.4.0/22 \
    104.16.0.0/13  104.24.0.0/14  108.162.192.0/18 \
    131.0.72.0/22  141.101.64.0/18 162.158.0.0/15 \
    172.64.0.0/13  173.245.48.0/20 188.114.96.0/20 \
    190.93.240.0/20 197.234.240.0/22 198.41.128.0/17; do
    openstack security group rule create --protocol tcp --dst-port 443 --remote-ip "$CIDR" cloudflare-only
    openstack security group rule create --protocol tcp --dst-port 80  --remote-ip "$CIDR" cloudflare-only
  done
  echo "      Created security group 'cloudflare-only'."
else
  echo "      Security group 'cloudflare-only' already exists — skipping."
fi

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

# Pre-create namespaces and secrets before Helm charts run so pods start cleanly
echo ""
echo "[3/4a] Pre-creating namespaces and K8s secrets..."
for NS in cip-infra cip-auth cip-app cip-observe; do
  kubectl create namespace "$NS" --dry-run=client -o yaml | kubectl apply -f -
done
bash scripts/create-secrets.sh

echo ""
echo "[3/4] Terraform cluster/ — node pool + infra Helm charts (postgres, nats, keycloak, monitoring)..."
echo "      Cluster ID: $CLUSTER_ID"
terraform -chdir=infra/terraform/cluster init -input=false -upgrade
terraform -chdir=infra/terraform/cluster apply -input=false -auto-approve

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
