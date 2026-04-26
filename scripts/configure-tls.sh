#!/usr/bin/env bash
set -euo pipefail

# Apply cert-manager ClusterIssuer for Let's Encrypt + Cloudflare DNS-01.
# Run after 'make bootstrap-infra' (cert-manager must be running first).
# Requires: CLOUDFLARE_API_TOKEN in environment.

echo "=== Configuring TLS (cert-manager + Let's Encrypt) ==="

# 1. Cloudflare API token secret (DNS-01 challenge)
echo "[1/2] Creating cert-manager/cloudflare-api-token secret..."
kubectl create secret generic cloudflare-api-token \
  --namespace cert-manager \
  --from-literal=api-token="${CLOUDFLARE_API_TOKEN}" \
  --dry-run=client -o yaml | kubectl apply -f -

# 2. ClusterIssuer (letsencrypt-prod + letsencrypt-staging)
echo "[2/2] Applying ClusterIssuer..."
kubectl wait deployment cert-manager \
  -n cert-manager --for=condition=Available --timeout=120s

kubectl apply -f infra/k8s/cert-manager-issuer.yaml

echo ""
echo "=== TLS configured ==="
echo "Issuers: letsencrypt-prod, letsencrypt-staging"
echo "Certificates will be issued automatically when Ingress resources are created."
echo "Monitor: kubectl get certificates -A"
