#!/usr/bin/env bash
set -euo pipefail

# Provision a new CIP tenant: creates the Keycloak realm + configures it
# (clients, mappers, AAD federation, flows), issues a LiteLLM virtual key,
# and prints the resulting credentials and next-step instructions.
#
# Idempotent: re-running for the same --tenant-id (or matching --name) skips
# already-configured pieces (HTTP 409 / "already exists" treated as success).
#
# Usage:
#   bash scripts/provision-tenant.sh \
#     --name "Acme Inc" \
#     --admin-email admin@acme.com \
#     [--aad-tenant-id <guid>]   # enables Teams SSO federation for this tenant
#     [--tier standard|enterprise|trial]   # default: standard
#     [--tenant-id <uuid>]   # optional override; default = generated UUID
#
# Requires: kubectl configured against the target cluster, KEYCLOAK_ADMIN_PASSWORD
# in env (sourced from .envrc), curl + jq on PATH. Run from repo root.

# ── 1. Parse args ─────────────────────────────────────────────────────────────
NAME=""
ADMIN_EMAIL=""
AAD_TENANT_ID=""
TIER="standard"
TENANT_ID=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name)            NAME="$2";            shift 2 ;;
    --admin-email)     ADMIN_EMAIL="$2";     shift 2 ;;
    --aad-tenant-id)   AAD_TENANT_ID="$2";   shift 2 ;;
    --tier)            TIER="$2";            shift 2 ;;
    --tenant-id)       TENANT_ID="$2";       shift 2 ;;
    -h|--help)
      sed -n '3,21p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

[[ -n "$NAME" ]]        || { echo "Error: --name is required"        >&2; exit 2; }
[[ -n "$ADMIN_EMAIL" ]] || { echo "Error: --admin-email is required" >&2; exit 2; }
[[ "$TIER" =~ ^(standard|enterprise|trial)$ ]] || { echo "Error: --tier must be standard|enterprise|trial" >&2; exit 2; }

if [[ -z "$TENANT_ID" ]]; then
  TENANT_ID=$(cat /proc/sys/kernel/random/uuid)
fi

REALM="$TENANT_ID"  # tenant_id IS the realm name — single identifier, no drift

echo "=== Provisioning tenant ==="
echo "  Display name:  $NAME"
echo "  Tenant ID:     $TENANT_ID"
echo "  Realm:         $REALM"
echo "  Admin email:   $ADMIN_EMAIL"
echo "  Tier:          $TIER"
[[ -n "$AAD_TENANT_ID" ]] && echo "  AAD tenant:    $AAD_TENANT_ID (Teams SSO federation enabled)"
echo ""

# ── 2. Locate Keycloak + get admin token ─────────────────────────────────────
echo "[1/6] Connecting to Keycloak..."
KC_SVC=$(kubectl get svc -n cip-auth -l app.kubernetes.io/name=keycloakx \
  --field-selector='spec.clusterIP!=None' \
  -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")
[[ -n "$KC_SVC" ]] || { echo "      ERROR: Keycloak service not found" >&2; exit 1; }

KC_LOCAL="http://localhost:18080/auth"
kubectl port-forward -n cip-auth "svc/$KC_SVC" 18080:80 &>/dev/null &
KC_PF_PID=$!
trap 'kill "$KC_PF_PID" 2>/dev/null || true' EXIT
sleep 3

_KC_ADMIN_PASS="${KEYCLOAK_ADMIN_PASSWORD:-}"
if [[ -z "$_KC_ADMIN_PASS" ]]; then
  _KC_ADMIN_PASS=$(kubectl get secret keycloak-credentials -n cip-auth \
    -o jsonpath='{.data.admin-password}' 2>/dev/null | base64 -d 2>/dev/null || echo "")
fi
[[ -n "$_KC_ADMIN_PASS" ]] || { echo "      ERROR: KEYCLOAK_ADMIN_PASSWORD not set in env or secret" >&2; exit 1; }

KC_ADMIN_TOKEN=$(curl -s -X POST "${KC_LOCAL}/realms/master/protocol/openid-connect/token" \
  --data-urlencode "client_id=admin-cli" \
  --data-urlencode "username=admin" \
  --data-urlencode "password=${_KC_ADMIN_PASS}" \
  --data-urlencode "grant_type=password" \
  | jq -r '.access_token')
[[ -n "$KC_ADMIN_TOKEN" && "$KC_ADMIN_TOKEN" != "null" ]] || { echo "      ERROR: failed to obtain KC admin token" >&2; exit 1; }
echo "      Connected."

# ── 3. Create realm with metadata in attributes ──────────────────────────────
echo "[2/6] Creating realm '$REALM'..."
REALM_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST "${KC_LOCAL}/admin/realms" \
  -H "Authorization: Bearer $KC_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$(jq -n \
    --arg realm "$REALM" \
    --arg displayName "$NAME" \
    --arg adminEmail "$ADMIN_EMAIL" \
    --arg tier "$TIER" \
    --arg aadTenantId "$AAD_TENANT_ID" \
    '{
      realm: $realm,
      enabled: true,
      displayName: $displayName,
      attributes: {
        cip_admin_email: $adminEmail,
        cip_tier: $tier,
        cip_aad_tenant_id: $aadTenantId,
        cip_provisioned_at: (now | todateiso8601)
      }
    }')")
case "$REALM_STATUS" in
  201) echo "      Realm created." ;;
  409) echo "      Realm already exists (skipped)." ;;
  *)   echo "      ERROR: realm creation returned HTTP $REALM_STATUS" >&2; exit 1 ;;
esac

# Idempotently update realm attributes (in case --name or --tier changed on re-run).
curl -s -o /dev/null \
  -X PUT "${KC_LOCAL}/admin/realms/${REALM}" \
  -H "Authorization: Bearer $KC_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$(jq -n \
    --arg displayName "$NAME" \
    --arg adminEmail "$ADMIN_EMAIL" \
    --arg tier "$TIER" \
    --arg aadTenantId "$AAD_TENANT_ID" \
    '{
      displayName: $displayName,
      attributes: {
        cip_admin_email: $adminEmail,
        cip_tier: $tier,
        cip_aad_tenant_id: $aadTenantId
      }
    }')"

# ── 4. tenantId protocol mapper at the realm level ────────────────────────────
# Projects the realm name as a "tenantId" claim into every token issued from
# this realm. Internal services (hr-service, mcp tools) read it for tenant scoping.
echo "[3/6] Adding tenantId protocol mapper..."
MAPPER_NAME="cip-tenant-id"
MAPPER_EXISTS=$(curl -s "${KC_LOCAL}/admin/realms/${REALM}/protocol-mappers/models" \
  -H "Authorization: Bearer $KC_ADMIN_TOKEN" \
  | jq -r --arg n "$MAPPER_NAME" '.[] | select(.name==$n) | .name' 2>/dev/null || echo "")

if [[ -n "$MAPPER_EXISTS" ]]; then
  echo "      Mapper already exists (skipped)."
else
  curl -s -o /dev/null -w "      tenantId mapper: HTTP %{http_code}\n" \
    -X POST "${KC_LOCAL}/admin/realms/${REALM}/protocol-mappers/models" \
    -H "Authorization: Bearer $KC_ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$(jq -n --arg n "$MAPPER_NAME" --arg v "$REALM" '{
      name: $n,
      protocol: "openid-connect",
      protocolMapper: "oidc-hardcoded-claim-mapper",
      config: {
        "claim.name": "tenantId",
        "claim.value": $v,
        "jsonType.label": "String",
        "id.token.claim": "true",
        "access.token.claim": "true",
        "userinfo.token.claim": "true"
      }
    }')"
fi

# ── 5. Confidential clients (teams-bot + hr-service) ──────────────────────────
create_client() {
  local CLIENT_ID="$1"
  local CLIENT_DESC="$2"
  local existing
  existing=$(curl -s "${KC_LOCAL}/admin/realms/${REALM}/clients?clientId=${CLIENT_ID}" \
    -H "Authorization: Bearer $KC_ADMIN_TOKEN" | jq -r '.[0].id // empty')

  if [[ -z "$existing" ]]; then
    curl -s -o /dev/null \
      -X POST "${KC_LOCAL}/admin/realms/${REALM}/clients" \
      -H "Authorization: Bearer $KC_ADMIN_TOKEN" \
      -H "Content-Type: application/json" \
      -d "$(jq -n --arg cid "$CLIENT_ID" --arg desc "$CLIENT_DESC" '{
        clientId: $cid,
        description: $desc,
        enabled: true,
        clientAuthenticatorType: "client-secret",
        serviceAccountsEnabled: true,
        publicClient: false,
        protocol: "openid-connect",
        standardFlowEnabled: false,
        directAccessGrantsEnabled: false
      }')"
    existing=$(curl -s "${KC_LOCAL}/admin/realms/${REALM}/clients?clientId=${CLIENT_ID}" \
      -H "Authorization: Bearer $KC_ADMIN_TOKEN" | jq -r '.[0].id // empty')
    echo "      $CLIENT_ID client: created"
  else
    echo "      $CLIENT_ID client: already exists"
  fi
  # Capture the secret regardless (idempotent reads).
  curl -s "${KC_LOCAL}/admin/realms/${REALM}/clients/${existing}/client-secret" \
    -H "Authorization: Bearer $KC_ADMIN_TOKEN" | jq -r '.value'
}

echo "[4/6] Creating confidential clients..."
TEAMS_BOT_SECRET=$(create_client "teams-bot" "Microsoft Teams bot — JWT AG exchange")
HR_SERVICE_SECRET=$(create_client "hr-service" "HR service — service account for KC admin API and MCP")

# ── 6. AAD IDP federation (only if --aad-tenant-id supplied) ─────────────────
if [[ -n "$AAD_TENANT_ID" ]]; then
  echo "[5/6] Configuring AAD federation..."
  # Reuse the BOT_APP_ID and BOT_APP_PASSWORD from env (the platform's bot app).
  # Customer-specific app registrations would override these via env at runtime.
  _BOT_APP_ID="${BOT_APP_ID:-}"
  _BOT_APP_PASSWORD=$(kubectl get secret teams-bot-credentials -n cip-app \
    -o jsonpath='{.data.BOT_APP_PASSWORD}' 2>/dev/null | base64 -d 2>/dev/null || echo "")

  if [[ -z "$_BOT_APP_ID" || -z "$_BOT_APP_PASSWORD" ]]; then
    echo "      WARNING: BOT_APP_ID / BOT_APP_PASSWORD missing — AAD IDP not configured."
    echo "      Set them in .envrc and re-run, or configure the IDP manually in KC admin UI."
  else
    AAD_EXISTS=$(curl -s "${KC_LOCAL}/admin/realms/${REALM}/identity-provider/instances/aad" \
      -H "Authorization: Bearer $KC_ADMIN_TOKEN" | jq -r '.alias // empty')
    if [[ -z "$AAD_EXISTS" ]]; then
      curl -s -o /dev/null -w "      AAD IDP: HTTP %{http_code}\n" \
        -X POST "${KC_LOCAL}/admin/realms/${REALM}/identity-provider/instances" \
        -H "Authorization: Bearer $KC_ADMIN_TOKEN" \
        -H "Content-Type: application/json" \
        -d "$(jq -n \
          --arg cid "$_BOT_APP_ID" \
          --arg cs "$_BOT_APP_PASSWORD" \
          --arg t "$AAD_TENANT_ID" \
          '{
            alias: "aad",
            displayName: "Microsoft AAD",
            providerId: "oidc",
            enabled: true,
            config: {
              clientId: $cid,
              clientSecret: $cs,
              tokenUrl: ("https://login.microsoftonline.com/"+$t+"/oauth2/v2.0/token"),
              authorizationUrl: ("https://login.microsoftonline.com/"+$t+"/oauth2/v2.0/authorize"),
              jwksUrl: ("https://login.microsoftonline.com/"+$t+"/discovery/v2.0/keys"),
              issuer: ("https://login.microsoftonline.com/"+$t+"/v2.0"),
              validateSignature: "true",
              useJwksUrl: "true",
              defaultScope: "openid profile email",
              syncMode: "FORCE",
              jwtAuthorizationGrantEnabled: "true",
              allowClientIdAsAudience: "true",
              jwtAuthorizationGrantMaxAllowedAssertionExpiration: "14400",
              supportsClientAssertionReuse: "true"
            }
          }')"
    else
      echo "      AAD IDP already exists (skipped)."
    fi

    # oid → BROKER_ID mapper so JWT AG matches users by Entra Object ID.
    OID_MAPPER_EXISTS=$(curl -s \
      "${KC_LOCAL}/admin/realms/${REALM}/identity-provider/instances/aad/mappers" \
      -H "Authorization: Bearer $KC_ADMIN_TOKEN" \
      | jq -r '.[] | select(.name=="aad-oid-as-user-id") | .name' 2>/dev/null || echo "")
    if [[ -z "$OID_MAPPER_EXISTS" ]]; then
      curl -s -o /dev/null \
        -X POST "${KC_LOCAL}/admin/realms/${REALM}/identity-provider/instances/aad/mappers" \
        -H "Authorization: Bearer $KC_ADMIN_TOKEN" \
        -H "Content-Type: application/json" \
        -d '{
          "name": "aad-oid-as-user-id",
          "identityProviderAlias": "aad",
          "identityProviderMapper": "oidc-username-idp-mapper",
          "config": {
            "template": "${CLAIM.oid}",
            "target": "BROKER_ID",
            "syncMode": "FORCE"
          }
        }'
      echo "      AAD oid mapper: created"
    fi
  fi
else
  echo "[5/6] Skipping AAD federation (no --aad-tenant-id supplied)."
fi

# ── 7. LiteLLM virtual key for the tenant ─────────────────────────────────────
echo "[6/6] Issuing LiteLLM virtual key..."
LITELLM_SVC=$(kubectl get svc litellm -n cip-app \
  -o jsonpath='{.metadata.name}' 2>/dev/null || echo "")

LITELLM_VKEY=""
if [[ -z "$LITELLM_SVC" ]]; then
  echo "      WARNING: LiteLLM service not found — skipping virtual key."
else
  kubectl port-forward -n cip-app svc/litellm 14000:4000 &>/dev/null &
  LL_PF_PID=$!
  sleep 3

  _MASTER_KEY=$(kubectl get secret litellm-credentials -n cip-app \
    -o jsonpath='{.data.LITELLM_MASTER_KEY}' 2>/dev/null | base64 -d 2>/dev/null || echo "")
  _MASTER_KEY="${_MASTER_KEY:-${LITELLM_MASTER_KEY:-}}"

  LL_RESP=$(curl -s -X POST http://localhost:14000/key/generate \
    -H "Authorization: Bearer $_MASTER_KEY" \
    -H "Content-Type: application/json" \
    -d "$(jq -n --arg t "$TENANT_ID" '{
      key_alias: ("cip-tenant-"+$t),
      metadata: { tenantId: $t },
      max_budget: 100
    }')")
  LITELLM_VKEY=$(echo "$LL_RESP" | jq -r '.key // empty')
  kill "$LL_PF_PID" 2>/dev/null || true

  if [[ -n "$LITELLM_VKEY" ]]; then
    echo "      Virtual key issued."
  else
    echo "      WARNING: LiteLLM did not return a key. Response: ${LL_RESP:0:200}"
  fi
fi

# ── 8. Print summary ─────────────────────────────────────────────────────────
cat <<EOF

============================================================
TENANT PROVISIONED
============================================================
Display name:      $NAME
Tenant ID:         $TENANT_ID
Keycloak realm:    $REALM
Tier:              $TIER
Admin email:       $ADMIN_EMAIL
$([ -n "$AAD_TENANT_ID" ] && echo "AAD tenant:        $AAD_TENANT_ID (federation configured)")

Client secrets (store securely — won't be shown again):
  teams-bot:       $TEAMS_BOT_SECRET
  hr-service:      $HR_SERVICE_SECRET

LiteLLM virtual key: ${LITELLM_VKEY:-<not issued>}

KC realm URL:      https://keycloak-cip.idlevice.ca/auth/realms/$REALM
KC admin console:  https://keycloak-cip.idlevice.ca/auth/admin/$REALM/console/

Next steps to make this tenant usable:

1. Store the client secrets somewhere persistent (vault, K8s secret, .envrc).
   For a dedicated bot deployment per tenant:
     kubectl create secret generic teams-bot-credentials-$REALM -n cip-app \\
       --from-literal=KEYCLOAK_CLIENT_SECRET=$TEAMS_BOT_SECRET \\
       --from-literal=BOT_APP_ID=...  \\
       --from-literal=BOT_APP_PASSWORD=... \\
       --from-literal=AWS_ACCESS_KEY_ID=... \\
       --from-literal=AWS_SECRET_ACCESS_KEY=...

2. To run a bot pod for this tenant, deploy a teams-bot release with
   KEYCLOAK_REALM=$REALM and the secret above:
     helm upgrade --install teams-bot-$REALM packages/teams-bot/helm \\
       -n cip-app --set env.KEYCLOAK_REALM=$REALM \\
       --set envFrom[0].secretRef.name=teams-bot-credentials-$REALM

3. Persist the LiteLLM virtual key into tenant_settings:
     UPDATE tenant_settings SET litellm_virtual_key='${LITELLM_VKEY:-<key>}'
       WHERE tenant_id='$TENANT_ID';

4. To create the first admin user in the realm, use KC admin console
   ($REALM) or call POST /admin/realms/$REALM/users via the admin API.
============================================================
EOF
