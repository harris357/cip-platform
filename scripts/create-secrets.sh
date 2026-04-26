#!/usr/bin/env bash
set -euo pipefail

# Recreate all K8s secrets from environment variables.
# Run after cluster recreation or secret rotation.
# Requires .envrc or equivalent to be sourced first.

echo "=== Creating K8s Secrets ==="

# Ensure namespaces exist (idempotent — Terraform normally creates these, but secrets may be needed before infra is fully up)
for ns in cip-app cip-auth cip-infra cert-manager; do
  kubectl get namespace "$ns" &>/dev/null || kubectl create namespace "$ns"
done

# LiteLLM credentials (only pod that gets ANTHROPIC_API_KEY)
kubectl create secret generic litellm-credentials \
  --namespace cip-app \
  --from-literal=ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY}" \
  --from-literal=LITELLM_MASTER_KEY="${LITELLM_MASTER_KEY}" \
  --from-literal=LANGFUSE_PUBLIC_KEY="${LANGFUSE_PUBLIC_KEY}" \
  --from-literal=LANGFUSE_SECRET_KEY="${LANGFUSE_SECRET_KEY}" \
  --from-literal=LANGFUSE_HOST="${LANGFUSE_HOST}" \
  --dry-run=client -o yaml | kubectl apply -f -

# HR Service credentials (virtual key only — NOT the real Anthropic key)
kubectl create secret generic hr-service-credentials \
  --namespace cip-app \
  --from-literal=LITELLM_VIRTUAL_KEY="${LITELLM_VIRTUAL_KEY}" \
  --from-literal=TEMPORAL_API_KEY="${TEMPORAL_API_KEY}" \
  --from-literal=TEMPORAL_ADDRESS="${TEMPORAL_ADDRESS}" \
  --from-literal=TEMPORAL_NAMESPACE="${TEMPORAL_NAMESPACE}" \
  --from-literal=DATABASE_URL_HR="${DATABASE_URL_HR}" \
  --dry-run=client -o yaml | kubectl apply -f -

# Platform Core credentials
kubectl create secret generic platform-core-credentials \
  --namespace cip-app \
  --from-literal=LITELLM_VIRTUAL_KEY="${LITELLM_VIRTUAL_KEY}" \
  --from-literal=TEMPORAL_API_KEY="${TEMPORAL_API_KEY}" \
  --from-literal=TEMPORAL_ADDRESS="${TEMPORAL_ADDRESS}" \
  --from-literal=TEMPORAL_NAMESPACE="${TEMPORAL_NAMESPACE}" \
  --from-literal=DATABASE_URL_PLATFORM="${DATABASE_URL_PLATFORM}" \
  --dry-run=client -o yaml | kubectl apply -f -

# Teams Bot credentials
kubectl create secret generic teams-bot-credentials \
  --namespace cip-app \
  --from-literal=LITELLM_VIRTUAL_KEY="${LITELLM_VIRTUAL_KEY}" \
  --from-literal=MICROSOFT_APP_ID="${MICROSOFT_APP_ID:-}" \
  --from-literal=MICROSOFT_APP_PASSWORD="${MICROSOFT_APP_PASSWORD:-}" \
  --dry-run=client -o yaml | kubectl apply -f -

# Langfuse credentials (DATABASE_URL, NEXTAUTH_SECRET, SALT)
kubectl create secret generic langfuse-credentials \
  --namespace cip-app \
  --from-literal=DATABASE_URL="${DATABASE_URL_PLATFORM}" \
  --from-literal=DIRECT_URL="${DATABASE_URL_PLATFORM}" \
  --from-literal=NEXTAUTH_SECRET="${LANGFUSE_SECRET_KEY}" \
  --from-literal=SALT="${LANGFUSE_SECRET_KEY}" \
  --dry-run=client -o yaml | kubectl apply -f -

# Keycloak credentials (admin password + DB password)
kubectl create secret generic keycloak-credentials \
  --namespace cip-auth \
  --from-literal=admin-password="${KEYCLOAK_ADMIN_PASSWORD}" \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl create secret generic keycloak-db-credentials \
  --namespace cip-auth \
  --from-literal=password="${PG_USER_PASSWORD}" \
  --dry-run=client -o yaml | kubectl apply -f -

# Postgres credentials
kubectl create secret generic postgres-credentials \
  --namespace cip-infra \
  --from-literal=password="${PG_USER_PASSWORD}" \
  --from-literal=postgres-password="${PG_ADMIN_PASSWORD}" \
  --dry-run=client -o yaml | kubectl apply -f -

# cert-manager Cloudflare token (DNS-01 TLS challenge)
kubectl create secret generic cloudflare-api-token \
  --namespace cert-manager \
  --from-literal=api-token="${CLOUDFLARE_API_TOKEN}" \
  --dry-run=client -o yaml | kubectl apply -f -

echo "=== Secrets created ==="
