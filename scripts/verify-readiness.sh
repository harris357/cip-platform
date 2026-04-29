#!/usr/bin/env bash
# scripts/verify-readiness.sh
#
# CIP Platform — Pre-code readiness check.
# Run this after completing slices/SLICE_00.md (Part B) and before starting Slice 01.
# Every check must show ✅ before proceeding.
#
# Usage:
#   source .envrc && bash scripts/verify-readiness.sh
#
# Exit codes:
#   0 — all checks passed
#   1 — one or more checks failed (failures listed at the end)

set -euo pipefail

# ── Colour helpers ────────────────────────────────────────────────────────────
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
RESET='\033[0m'

pass() { echo -e "  ${GREEN}✅${RESET} $1"; }
fail() { echo -e "  ${RED}❌${RESET} $1"; FAILURES+=("$1"); }
warn() { echo -e "  ${YELLOW}⚠️ ${RESET} $1"; }
header() { echo -e "\n${BOLD}▶ $1${RESET}"; }

FAILURES=()

# ── 1. Required tools ─────────────────────────────────────────────────────────
header "Required tools"

for tool in kubectl helm temporal aws curl jq openssl; do
  if command -v "$tool" &>/dev/null; then
    pass "$tool found ($(command -v "$tool"))"
  else
    fail "$tool not found — install it before continuing"
  fi
done

# ── 2. .envrc completeness ────────────────────────────────────────────────────
header ".envrc — required variables"

REQUIRED_VARS=(
  # OVH
  OVH_PROJECT_ID
  OVH_APP_KEY
  OVH_APP_SECRET
  OVH_CONSUMER_KEY
  OVH_CLUSTER_ID
  OVH_NODEPOOL_ID
  OVH_LB_IP
  KUBECONFIG
  # OVH Object Store
  OVH_S3_ACCESS_KEY
  OVH_S3_SECRET_KEY
  AWS_ENDPOINT_URL
  AWS_REGION
  # Cloudflare
  CF_ZONE_ID
  CF_ACCOUNT_ID
  CLOUDFLARE_API_TOKEN
  # Temporal
  TEMPORAL_NAMESPACE
  TEMPORAL_ADDRESS
  TEMPORAL_API_KEY
  TEMPORAL_TASK_QUEUE_HR
  TEMPORAL_TASK_QUEUE_PLATFORM
  # Langfuse
  LANGFUSE_PUBLIC_KEY
  LANGFUSE_SECRET_KEY
  LANGFUSE_HOST
  # Anthropic (LiteLLM pod only)
  ANTHROPIC_API_KEY
  # PostgreSQL
  PG_ADMIN_PASSWORD
  PG_USER_PASSWORD
  DATABASE_URL_HR
  DATABASE_URL_PLATFORM
  DATABASE_URL_LITELLM
  # Keycloak
  KEYCLOAK_ADMIN_PASSWORD
  KEYCLOAK_URL
  KEYCLOAK_REALM
  KEYCLOAK_CLIENT_ID
  # LiteLLM
  LITELLM_MASTER_KEY
  LITELLM_BASE_URL
  LITELLM_VIRTUAL_KEY
  # Communications
  TWILIO_ACCOUNT_SID
  TWILIO_AUTH_TOKEN
  TWILIO_PHONE_NUMBER
  RESEND_API_KEY
  RESEND_FROM_EMAIL
  # Azure Bot
  BOT_APP_ID
  BOT_APP_PASSWORD
  # Dev tenant
  DEV_TENANT_ID
)

for var in "${REQUIRED_VARS[@]}"; do
  val="${!var:-}"
  if [[ -z "$val" ]]; then
    fail "$var is empty or unset"
  elif [[ "$val" == "your-"* ]] || [[ "$val" == "<"* ]] || [[ "$val" == "xxx"* ]]; then
    fail "$var looks like a placeholder: $val"
  else
    # Show last 4 chars only to confirm it's set without leaking secrets
    masked="${val: -4}"
    pass "$var is set (...${masked})"
  fi
done

# ── 3. kubectl connectivity ───────────────────────────────────────────────────
header "Kubernetes cluster"

if kubectl cluster-info &>/dev/null 2>&1; then
  pass "kubectl connected to cluster"
else
  fail "kubectl cannot reach cluster — check KUBECONFIG=$KUBECONFIG"
fi

# ── 4. Required namespaces ────────────────────────────────────────────────────
header "Kubernetes namespaces"

for ns in cip-app cip-infra cip-auth cert-manager ingress-nginx; do
  if kubectl get namespace "$ns" &>/dev/null 2>&1; then
    pass "namespace $ns exists"
  else
    fail "namespace $ns missing — run: kubectl apply -f infra/k8s/namespaces.yaml"
  fi
done

# ── 5. Kubernetes secrets ─────────────────────────────────────────────────────
header "Kubernetes secrets"

check_secret() {
  local ns="$1"
  local name="$2"
  if kubectl get secret "$name" -n "$ns" &>/dev/null 2>&1; then
    pass "secret $name in $ns"
  else
    fail "secret $name missing from $ns — run scripts/create-secrets.sh"
  fi
}

check_secret cip-app    temporal-credentials
check_secret cip-app    langfuse-credentials
check_secret cip-app    litellm-credentials
check_secret cip-app    ovh-object-store
check_secret cip-app    teams-bot-credentials
check_secret cip-app    communications-credentials
check_secret cip-infra  postgres-credentials
check_secret cip-auth   keycloak-admin-credentials
check_secret cert-manager cloudflare-api-token

# Extra check: confirm ANTHROPIC_API_KEY is NOT in domain service secrets
header "Security — ANTHROPIC_API_KEY isolation"

for svc_secret in temporal-credentials langfuse-credentials teams-bot-credentials communications-credentials; do
  if kubectl get secret "$svc_secret" -n cip-app &>/dev/null 2>&1; then
    if kubectl get secret "$svc_secret" -n cip-app -o jsonpath='{.data}' 2>/dev/null | grep -q "ANTHROPIC_API_KEY"; then
      fail "ANTHROPIC_API_KEY found in $svc_secret — it must only be in litellm-credentials"
    else
      pass "ANTHROPIC_API_KEY absent from $svc_secret (correct)"
    fi
  fi
done

# ── 6. OVH Object Store ───────────────────────────────────────────────────────
header "OVH Object Store (S3)"

if aws s3 ls --endpoint-url "https://${AWS_ENDPOINT_URL#https://}" &>/dev/null 2>&1; then
  pass "OVH S3 reachable at $AWS_ENDPOINT_URL"
else
  fail "OVH S3 not reachable — check OVH_S3_ACCESS_KEY, OVH_S3_SECRET_KEY, AWS_ENDPOINT_URL"
fi

# ── 7. Cloudflare API token ───────────────────────────────────────────────────
header "Cloudflare"

CF_STATUS=$(curl -sf "https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  | jq -r '.success' 2>/dev/null || echo "false")

if [[ "$CF_STATUS" == "true" ]]; then
  pass "Cloudflare API token is active"
else
  fail "Cloudflare API token invalid or unreachable — check CLOUDFLARE_API_TOKEN and CF_ZONE_ID"
fi

# Check DNS records exist for primary subdomains
header "Cloudflare DNS records"

DOMAIN="${DOMAIN:-idlevice.ca}"
ENV_PREFIX="${ENV_PREFIX:-cip}"
for subdomain in api keycloak grafana bot; do
  FQDN="${subdomain}-${ENV_PREFIX}.${DOMAIN}"
  CF_RECORD=$(curl -sf \
    "https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/dns_records?name=${FQDN}" \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    | jq -r '.result | length' 2>/dev/null || echo "0")
  if [[ "$CF_RECORD" -gt 0 ]]; then
    pass "DNS record exists for $FQDN"
  else
    warn "No DNS record for $FQDN — create it after getting the OVH LB IP"
  fi
done

# Check SSL mode is Full (Strict), not just Full
#CF_SSL_MODE=$(curl -sf \
#  "https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/settings/ssl" \
#  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
#  | jq -r '.result.value' 2>/dev/null || echo "unknown")#

#if [[ "$CF_SSL_MODE" == "strict" ]]; then
#  pass "Cloudflare SSL mode is Full (Strict)"
#else
#  fail "Cloudflare SSL mode is '$CF_SSL_MODE' — must be 'strict'. Set it in: Cloudflare → SSL/TLS → Overview → Full (strict)"
#fi

warn "Cloudflare SSL mode cannot be verified via DNS-scoped token — manually confirm Full (Strict) is set at: Cloudflare → SSL/TLS → Overview"

# ── 8. Temporal Cloud ─────────────────────────────────────────────────────────
header "Temporal Cloud"

if temporal operator namespace describe \
    --namespace "$TEMPORAL_NAMESPACE" \
    --address "$TEMPORAL_ADDRESS" \
    --api-key "$TEMPORAL_API_KEY" \
    --tls \
    &>/dev/null 2>&1; then
  pass "Temporal namespace $TEMPORAL_NAMESPACE exists"
else
  fail "Cannot connect to Temporal Cloud at $TEMPORAL_ADDRESS — check TEMPORAL_API_KEY and TEMPORAL_ADDRESS format"
fi

# ── 9. Langfuse Cloud ─────────────────────────────────────────────────────────
header "Langfuse Cloud"

LANGFUSE_STATUS=$(curl -sf "$LANGFUSE_HOST/api/public/health" \
  -u "$LANGFUSE_PUBLIC_KEY:$LANGFUSE_SECRET_KEY" \
  | jq -r '.status' 2>/dev/null || echo "error")

if [[ "$LANGFUSE_STATUS" == "OK" ]]; then
  pass "Langfuse health check passed at $LANGFUSE_HOST"
else
  fail "Langfuse health check failed (status: $LANGFUSE_STATUS) — check LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY"
fi

# ── 10. LiteLLM (if already deployed) ────────────────────────────────────────
header "LiteLLM proxy (skipped if not yet deployed)"

LITELLM_INTERNAL="http://litellm.cip-app.svc.cluster.local:4000"
# Try port-forward detection: check if pod is running
if kubectl get pod -n cip-app -l app=litellm --field-selector=status.phase=Running 2>/dev/null | grep -q "Running"; then
  # Use kubectl exec to call health from inside the cluster
  LITELLM_HEALTH=$(kubectl exec -n cip-app \
    "$(kubectl get pod -n cip-app -l app=litellm -o jsonpath='{.items[0].metadata.name}')" \
    -- curl -sf http://localhost:4000/health/liveliness 2>/dev/null \
    | jq -r '.status' 2>/dev/null || echo "error")

  if [[ "$LITELLM_HEALTH" == "healthy" ]]; then
    pass "LiteLLM pod is running and healthy"

    # Check model aliases
    LITELLM_MODELS=$(kubectl exec -n cip-app \
      "$(kubectl get pod -n cip-app -l app=litellm -o jsonpath='{.items[0].metadata.name}')" \
      -- curl -sf -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
      http://localhost:4000/models 2>/dev/null \
      | jq -r '[.data[].id] | @csv' 2>/dev/null || echo "")

    for alias in cip-vision cip-chat cip-lightweight cip-reasoning; do
      if echo "$LITELLM_MODELS" | grep -q "$alias"; then
        pass "LiteLLM alias $alias registered"
      else
        fail "LiteLLM alias $alias not found — check infra/k8s/litellm-config.yaml"
      fi
    done

    # Check LITELLM_VIRTUAL_KEY is set (issued after deployment)
    if [[ -n "${LITELLM_VIRTUAL_KEY:-}" ]] && [[ "$LITELLM_VIRTUAL_KEY" == "sk-"* ]]; then
      pass "LITELLM_VIRTUAL_KEY is set"
    else
      fail "LITELLM_VIRTUAL_KEY is not set — issue a dev tenant key via the LiteLLM Admin API (see slices/SLICE_00.md Section 11)"
    fi
  else
    fail "LiteLLM pod found but health check failed (status: $LITELLM_HEALTH)"
  fi
else
  warn "LiteLLM pod not running — skip this check until after Slice 04 + make start"
fi

# ── 11. PostgreSQL PVCs ───────────────────────────────────────────────────────
header "Persistent Volume Claims"

EXPECTED_PVCS=(postgres-data nats-data keycloak-data langfuse-data litellm-logs)
for pvc in "${EXPECTED_PVCS[@]}"; do
  PVC_STATUS=$(kubectl get pvc "$pvc" -n cip-infra \
    -o jsonpath='{.status.phase}' 2>/dev/null || echo "NotFound")
  if [[ "$PVC_STATUS" == "Bound" ]]; then
    pass "PVC $pvc is Bound"
  elif [[ "$PVC_STATUS" == "Pending" ]]; then
    warn "PVC $pvc is Pending — may need a node to be scheduled"
  else
    fail "PVC $pvc not found in cip-infra — run: kubectl apply -f infra/k8s/pvcs.yaml"
  fi
done

# ── 12. Twilio ────────────────────────────────────────────────────────────────
header "Twilio (SMS)"

TWILIO_RESPONSE=$(curl -sf \
  "https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}.json" \
  -u "$TWILIO_ACCOUNT_SID:$TWILIO_AUTH_TOKEN" \
  | jq -r '.status' 2>/dev/null || echo "error")

if [[ "$TWILIO_RESPONSE" == "active" ]]; then
  pass "Twilio account $TWILIO_ACCOUNT_SID is active"
else
  fail "Twilio account check failed (status: $TWILIO_RESPONSE) — verify TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN"
fi

# ── 13. Resend ────────────────────────────────────────────────────────────────
header "Resend (email)"

RESEND_RESPONSE=$(curl -sf "https://api.resend.com/domains" \
  -H "Authorization: Bearer $RESEND_API_KEY" \
  | jq -r '.data | length' 2>/dev/null || echo "error")

if [[ "$RESEND_RESPONSE" =~ ^[0-9]+$ ]] && [[ "$RESEND_RESPONSE" -gt 0 ]]; then
  pass "Resend API key valid, $RESEND_RESPONSE domain(s) registered"
elif [[ "$RESEND_RESPONSE" == "0" ]]; then
  fail "Resend API key valid but no verified domain — add and verify a domain at resend.com"
else
  fail "Resend API key invalid or unreachable — check RESEND_API_KEY"
fi

# ── 14. Dev tenant UUID format ────────────────────────────────────────────────
header "Dev tenant ID"

UUID_REGEX='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
if [[ "$DEV_TENANT_ID" =~ $UUID_REGEX ]]; then
  pass "DEV_TENANT_ID is a valid UUID: $DEV_TENANT_ID"
else
  fail "DEV_TENANT_ID is not a valid UUID: $DEV_TENANT_ID"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}═══════════════════════════════════════════${RESET}"
echo -e "${BOLD}  CIP Platform Readiness Summary${RESET}"
echo -e "${BOLD}═══════════════════════════════════════════${RESET}"

if [[ ${#FAILURES[@]} -eq 0 ]]; then
  echo -e "\n  ${GREEN}${BOLD}All checks passed. Ready to start Slice 01.${RESET}\n"
  exit 0
else
  echo -e "\n  ${RED}${BOLD}${#FAILURES[@]} check(s) failed:${RESET}"
  for f in "${FAILURES[@]}"; do
    echo -e "  ${RED}•${RESET} $f"
  done
  echo -e "\n  Fix all failures before starting Slice 01.\n"
  exit 1
fi
