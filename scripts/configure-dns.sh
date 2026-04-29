#!/usr/bin/env bash
set -euo pipefail

# Create or update Cloudflare A records pointing *.cip.idlevice.ca at the OVH LB IP.
# Run after 'make bootstrap-infra' once the ingress-nginx LoadBalancer IP is assigned.
# Requires: CF_ZONE_ID, CLOUDFLARE_API_TOKEN in environment (.envrc sourced).

DOMAIN="${DOMAIN:-cip.idlevice.ca}"

# Get LB IP from the cluster (preferred) or fall back to OVH_LB_IP env var
LB_IP=""
if kubectl get svc -n ingress-nginx ingress-nginx-controller &>/dev/null 2>&1; then
  LB_IP=$(kubectl get svc -n ingress-nginx ingress-nginx-controller \
    -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || echo "")
fi

if [[ -z "$LB_IP" ]]; then
  LB_IP="${OVH_LB_IP:-}"
fi

if [[ -z "$LB_IP" ]]; then
  echo "ERROR: could not determine LB IP."
  echo "  Option 1: wait for ingress-nginx to get its IP, then re-run"
  echo "  Option 2: set OVH_LB_IP=<ip> in .envrc and re-run"
  exit 1
fi

echo "=== Configuring Cloudflare DNS ==="
echo "  Domain : $DOMAIN"
echo "  LB IP  : $LB_IP"
echo "  Zone   : $CF_ZONE_ID"
echo ""

CF_API="https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/dns_records"

upsert_record() {
  local name="$1"
  echo -n "  A  $name → $LB_IP ... "

  # Check if record exists
  EXISTING_ID=$(curl -sf "$CF_API?name=${name}&type=A" \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    | jq -r '.result[0].id // empty' 2>/dev/null || echo "")

  if [[ -n "$EXISTING_ID" ]]; then
    # Update existing
    curl -sf -X PUT "$CF_API/$EXISTING_ID" \
      -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
      -H "Content-Type: application/json" \
      -d "{\"type\":\"A\",\"name\":\"$name\",\"content\":\"$LB_IP\",\"ttl\":300,\"proxied\":true}" \
      | jq -r '.success' | grep -q true && echo "updated" || echo "FAILED"
  else
    # Create new
    curl -sf -X POST "$CF_API" \
      -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
      -H "Content-Type: application/json" \
      -d "{\"type\":\"A\",\"name\":\"$name\",\"content\":\"$LB_IP\",\"ttl\":300,\"proxied\":true}" \
      | jq -r '.success' | grep -q true && echo "created" || echo "FAILED"
  fi
}

# One record per service + a wildcard for convenience
upsert_record "keycloak.${DOMAIN}"
upsert_record "api.${DOMAIN}"
upsert_record "langfuse.${DOMAIN}"
upsert_record "bot.${DOMAIN}"
upsert_record "grafana.${DOMAIN}"
upsert_record "*.${DOMAIN}"

echo ""
echo "=== DNS configured ==="
echo "Add to .envrc:"
echo "  export OVH_LB_IP=$LB_IP"
echo ""
echo "Next: make configure-tls  (applies cert-manager ClusterIssuer)"
