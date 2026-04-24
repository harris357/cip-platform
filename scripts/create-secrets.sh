#!/usr/bin/env bash
set -euo pipefail

# Recreate all K8s secrets from environment variables.
# Run after cluster recreation or secret rotation.
# Requires .envrc or equivalent to be sourced first.

echo "=== Creating K8s Secrets ==="

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

echo "=== Secrets created ==="
