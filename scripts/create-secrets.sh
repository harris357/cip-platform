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

# Recurring footgun fix: .envrc historically has DATABASE_URL_* with literal
# "PASSWORD" placeholders that were supposed to interpolate $PG_USER_PASSWORD
# but didn't (single-quote + literal vs double-quote interpolation issue).
# Substitute server-side here so the secret always lands with the real
# password from $PG_USER_PASSWORD, regardless of what shape .envrc has.
if [[ -n "${PG_USER_PASSWORD:-}" ]]; then
  DATABASE_URL_HR="${DATABASE_URL_HR//PASSWORD/$PG_USER_PASSWORD}"
  DATABASE_URL_PLATFORM="${DATABASE_URL_PLATFORM//PASSWORD/$PG_USER_PASSWORD}"
  DATABASE_URL_LITELLM="${DATABASE_URL_LITELLM//PASSWORD/$PG_USER_PASSWORD}"
fi

# LiteLLM credentials (provider API keys all live here — secrets never reach app pods)
kubectl create secret generic litellm-credentials \
  --namespace cip-app \
  --from-literal=ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY}" \
  --from-literal=MISTRAL_API_KEY="${MISTRAL_API_KEY:-}" \
  --from-literal=LITELLM_MASTER_KEY="${LITELLM_MASTER_KEY}" \
  --from-literal=LITELLM_DATABASE_URL="${DATABASE_URL_LITELLM}" \
  --from-literal=LANGFUSE_PUBLIC_KEY="${LANGFUSE_PUBLIC_KEY}" \
  --from-literal=LANGFUSE_SECRET_KEY="${LANGFUSE_SECRET_KEY}" \
  --from-literal=LANGFUSE_HOST="${LANGFUSE_HOST}" \
  --dry-run=client -o yaml | kubectl apply -f -

# PLATFORM_ADMIN_TOKEN: shared bearer token used between platform-core,
# teams-bot, and hr-service for the /admin/tenants* endpoints. Must be
# the SAME value on all three. Generate once in .envrc:
#   export PLATFORM_ADMIN_TOKEN="$(openssl rand -hex 32)"
# Empty default → endpoints return 401 to everyone (intentionally fail-closed).

# HR Service credentials (virtual key only — NOT the real Anthropic key)
# Slice 41: LANGFUSE_* added so getPrompt() can fetch from Langfuse Cloud.
# Without these, getPrompt() falls back to baked-in defaults.
# Slice 42B: PLATFORM_ADMIN_EMAIL drives auto-elevation in sync_employee.
# Empty = no auto-elevation (manual only).
kubectl create secret generic hr-service-credentials \
  --namespace cip-app \
  --from-literal=LITELLM_VIRTUAL_KEY="${LITELLM_VIRTUAL_KEY}" \
  --from-literal=TEMPORAL_API_KEY="${TEMPORAL_API_KEY}" \
  --from-literal=TEMPORAL_ADDRESS="${TEMPORAL_ADDRESS}" \
  --from-literal=TEMPORAL_NAMESPACE="${TEMPORAL_NAMESPACE}" \
  --from-literal=DATABASE_URL_HR="${DATABASE_URL_HR}" \
  --from-literal=PLATFORM_ADMIN_TOKEN="${PLATFORM_ADMIN_TOKEN:-}" \
  --from-literal=PLATFORM_ADMIN_EMAIL="${PLATFORM_ADMIN_EMAIL:-}" \
  --from-literal=AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-}" \
  --from-literal=AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-}" \
  --from-literal=LANGFUSE_PUBLIC_KEY="${LANGFUSE_PUBLIC_KEY:-}" \
  --from-literal=LANGFUSE_SECRET_KEY="${LANGFUSE_SECRET_KEY:-}" \
  --from-literal=LANGFUSE_HOST="${LANGFUSE_HOST:-https://cloud.langfuse.com}" \
  --from-literal=LANGFUSE_PROJECT_ID="${LANGFUSE_PROJECT_ID:-}" \
  --dry-run=client -o yaml | kubectl apply -f -

# Platform Core credentials
kubectl create secret generic platform-core-credentials \
  --namespace cip-app \
  --from-literal=LITELLM_VIRTUAL_KEY="${LITELLM_VIRTUAL_KEY}" \
  --from-literal=TEMPORAL_API_KEY="${TEMPORAL_API_KEY}" \
  --from-literal=TEMPORAL_ADDRESS="${TEMPORAL_ADDRESS}" \
  --from-literal=TEMPORAL_NAMESPACE="${TEMPORAL_NAMESPACE}" \
  --from-literal=DATABASE_URL_PLATFORM="${DATABASE_URL_PLATFORM}" \
  --from-literal=PLATFORM_ADMIN_TOKEN="${PLATFORM_ADMIN_TOKEN:-}" \
  --dry-run=client -o yaml | kubectl apply -f -

# Teams Bot credentials
# Slice 41: LANGFUSE_* added so getPrompt() can fetch from Langfuse Cloud.
kubectl create secret generic teams-bot-credentials \
  --namespace cip-app \
  --from-literal=LITELLM_VIRTUAL_KEY="${LITELLM_VIRTUAL_KEY}" \
  --from-literal=BOT_APP_ID="${BOT_APP_ID:-}" \
  --from-literal=BOT_APP_PASSWORD="${BOT_APP_PASSWORD:-}" \
  --from-literal=KEYCLOAK_CLIENT_SECRET="${KEYCLOAK_CLIENT_SECRET:-}" \
  --from-literal=PLATFORM_ADMIN_TOKEN="${PLATFORM_ADMIN_TOKEN:-}" \
  --from-literal=AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-}" \
  --from-literal=AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-}" \
  --from-literal=LANGFUSE_PUBLIC_KEY="${LANGFUSE_PUBLIC_KEY:-}" \
  --from-literal=LANGFUSE_SECRET_KEY="${LANGFUSE_SECRET_KEY:-}" \
  --from-literal=LANGFUSE_HOST="${LANGFUSE_HOST:-https://cloud.langfuse.com}" \
  --from-literal=LANGFUSE_PROJECT_ID="${LANGFUSE_PROJECT_ID:-}" \
  --from-literal=DATABASE_URL_HR="${DATABASE_URL_HR}" \
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

# Cloudflare Tunnel credentials (cloudflared pod — admin service access)
kubectl create secret generic cloudflare-tunnel-credentials \
  --namespace cip-infra \
  --from-literal=token="${CLOUDFLARE_TUNNEL_TOKEN}" \
  --dry-run=client -o yaml | kubectl apply -f -

echo "=== Secrets created ==="
