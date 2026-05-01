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

# ── Slice 37: store the per-tenant KC client secret as a K8s secret ──────────
# Naming convention: tenant-aad-<TENANT_ID> (lowercase UUID). The bot reads
# this via its ServiceAccount on cache miss; updating it (rotation) takes
# effect within 5 minutes without a bot pod restart.
TENANT_KC_SECRET_NAME="tenant-aad-${TENANT_ID}"
echo "[5a/6] Writing per-tenant K8s secret ${TENANT_KC_SECRET_NAME}..."
kubectl create secret generic "${TENANT_KC_SECRET_NAME}" \
  --namespace cip-app \
  --from-literal=KEYCLOAK_CLIENT_SECRET="${TEAMS_BOT_SECRET}" \
  --dry-run=client -o yaml | kubectl apply -f - \
  | sed 's/^/      /'

# Update tenant_identity_providers.secret_ref so the bot's resolver picks
# up the new secret on its next cache miss. Runs inside the postgres pod —
# no local psql required.
POSTGRES_POD=$(kubectl get pod -n cip-infra -l app.kubernetes.io/name=postgresql \
  -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")
if [[ -n "$POSTGRES_POD" && -n "${PG_USER_PASSWORD:-}" ]]; then
  echo "[5b/6] Updating tenant_identity_providers.secret_ref..."
  kubectl exec -i -n cip-infra "$POSTGRES_POD" -- \
    env PGPASSWORD="$PG_USER_PASSWORD" psql -U cipuser -d cip_hr -v ON_ERROR_STOP=1 <<SQL 2>&1 \
      | sed 's/^/      /' || true
UPDATE tenant_identity_providers
   SET secret_ref = '${TENANT_KC_SECRET_NAME}', updated_at = NOW()
 WHERE tenant_id = '${TENANT_ID}'::uuid
   AND provider_type = 'aad_oidc';
SQL
else
  echo "      WARNING: skipping secret_ref UPDATE (postgres pod or PG_USER_PASSWORD missing)"
  echo "      Manually: UPDATE tenant_identity_providers SET secret_ref='${TENANT_KC_SECRET_NAME}'"
  echo "                WHERE tenant_id='${TENANT_ID}' AND provider_type='aad_oidc';"
fi

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

# ── 6a. LiteLLM tier policy (Slice 40) + 7. virtual key issuance ─────────────
# Both steps share a single LiteLLM port-forward + master-key fetch.
echo "[6/7] Setting LiteLLM team policy + issuing virtual key..."
LITELLM_SVC=$(kubectl get svc litellm -n cip-app \
  -o jsonpath='{.metadata.name}' 2>/dev/null || echo "")

LITELLM_VKEY=""
MAX_BUDGET=0
RPM_LIMIT=0
MODELS='[]'

# Tier → policy mapping. Trial gets the bot baseline only (no vision, no
# reasoning) — keeps demo/pilot tenants from accidentally burning premium
# model budget. Standard adds the cert workflow + cheap OCR. Enterprise
# unlocks the premium reasoning + full-quality OCR aliases.
case "$TIER" in
  trial)
    MAX_BUDGET=10
    RPM_LIMIT=60
    MODELS='["cip-classifier","cip-chat","cip-router-fast","cip-lightweight","cip-document"]'
    ;;
  standard)
    MAX_BUDGET=200
    RPM_LIMIT=300
    MODELS='["cip-classifier","cip-chat","cip-router-fast","cip-router-careful","cip-lightweight","cip-document","cip-vision","cip-ocr-document-small","cip-ocr-image-small"]'
    ;;
  enterprise)
    MAX_BUDGET=2000
    RPM_LIMIT=1500
    MODELS='["cip-classifier","cip-chat","cip-router-fast","cip-router-careful","cip-reasoning","cip-lightweight","cip-document","cip-vision","cip-ocr-document","cip-ocr-document-small","cip-ocr-image","cip-ocr-image-small"]'
    ;;
  *)
    # Already validated at arg-parse time, but defense in depth.
    echo "      ERROR: unknown tier '$TIER'" >&2
    exit 1
    ;;
esac

if [[ -z "$LITELLM_SVC" ]]; then
  echo "      WARNING: LiteLLM service not found — skipping team policy + virtual key."
else
  kubectl port-forward -n cip-app svc/litellm 14000:4000 &>/dev/null &
  LL_PF_PID=$!
  sleep 3

  _MASTER_KEY=$(kubectl get secret litellm-credentials -n cip-app \
    -o jsonpath='{.data.LITELLM_MASTER_KEY}' 2>/dev/null | base64 -d 2>/dev/null || echo "")
  _MASTER_KEY="${_MASTER_KEY:-${LITELLM_MASTER_KEY:-}}"

  # ── Slice 40: tier-driven team policy ──────────────────────────────────────
  TEAM_PAYLOAD=$(jq -n \
    --arg id    "$TENANT_ID" \
    --arg name  "$NAME" \
    --arg dur   "30d" \
    --arg tier  "$TIER" \
    --argjson budget "$MAX_BUDGET" \
    --argjson rpm    "$RPM_LIMIT" \
    --argjson models "$MODELS" \
    '{
      team_id:         $id,
      team_alias:      $name,
      max_budget:      $budget,
      budget_duration: $dur,
      rpm_limit:       $rpm,
      models:          $models,
      metadata:        { tier: $tier }
    }')

  # Try create first; on 400/409 (already exists), update instead.
  TEAM_NEW=$(curl -s -w "\n%{http_code}" -X POST http://localhost:14000/team/new \
    -H "Authorization: Bearer $_MASTER_KEY" \
    -H "Content-Type: application/json" \
    -d "$TEAM_PAYLOAD")
  TEAM_NEW_STATUS=$(echo "$TEAM_NEW" | tail -1)
  case "$TEAM_NEW_STATUS" in
    200|201) echo "      Team created (tier=$TIER)." ;;
    400|409)
      TEAM_UPD=$(curl -s -w "\n%{http_code}" -X POST http://localhost:14000/team/update \
        -H "Authorization: Bearer $_MASTER_KEY" \
        -H "Content-Type: application/json" \
        -d "$TEAM_PAYLOAD")
      TEAM_UPD_STATUS=$(echo "$TEAM_UPD" | tail -1)
      if [[ "$TEAM_UPD_STATUS" =~ ^20[0-9]$ ]]; then
        echo "      Team policy updated (tier=$TIER)."
      else
        kill "$LL_PF_PID" 2>/dev/null || true
        echo "      ERROR: team update failed: HTTP $TEAM_UPD_STATUS" >&2
        echo "      Response: $(echo "$TEAM_UPD" | head -n -1 | head -c 200)" >&2
        exit 1
      fi
      ;;
    *)
      kill "$LL_PF_PID" 2>/dev/null || true
      echo "      ERROR: team create failed: HTTP $TEAM_NEW_STATUS" >&2
      echo "      Response: $(echo "$TEAM_NEW" | head -n -1 | head -c 200)" >&2
      exit 1
      ;;
  esac

  # Verify by reading /team/info — non-fatal warning if it disagrees.
  TEAM_INFO=$(curl -s -H "Authorization: Bearer $_MASTER_KEY" \
    "http://localhost:14000/team/info?team_id=$TENANT_ID")
  ACTUAL_BUDGET=$(echo "$TEAM_INFO" | jq -r '.team_info.max_budget // "?"')
  if [[ "$ACTUAL_BUDGET" != "$MAX_BUDGET" ]]; then
    echo "      WARNING: /team/info reports max_budget=$ACTUAL_BUDGET (expected $MAX_BUDGET)" >&2
  fi
  echo "      Tier policy: budget=\$$MAX_BUDGET/30d, rpm=$RPM_LIMIT, $(echo "$MODELS" | jq -r 'length') aliases."

  # ── Virtual key issued under the team — inherits team's budget + models ────
  LL_RESP=$(curl -s -X POST http://localhost:14000/key/generate \
    -H "Authorization: Bearer $_MASTER_KEY" \
    -H "Content-Type: application/json" \
    -d "$(jq -n --arg t "$TENANT_ID" '{
      key_alias: ("cip-tenant-"+$t),
      team_id:   $t,
      metadata:  { tenantId: $t }
    }')")
  LITELLM_VKEY=$(echo "$LL_RESP" | jq -r '.key // empty')
  kill "$LL_PF_PID" 2>/dev/null || true

  if [[ -n "$LITELLM_VKEY" ]]; then
    echo "      Virtual key issued under team $TENANT_ID."
  else
    echo "      WARNING: LiteLLM did not return a key. Response: ${LL_RESP:0:200}"
  fi
fi

# ── 7a. Admin user elevation (Slice 42B) ─────────────────────────────────────
# Per-tenant precedence: --admin-email (the customer's admin) wins;
# PLATFORM_ADMIN_EMAIL is a fallback if --admin-email isn't supplied.
# Both halves of defense-in-depth fire:
#   - CIP role: INSERT into employee_role_assignments → hr-service-admin
#   - KC role:  POST /role-mappings/realm with `hr` (idempotent)
# Idempotent — ON CONFLICT DO NOTHING + KC's natural idempotence.
echo "[7a/7] Elevating admin email to hr-service-admin role for tenant $TENANT_ID..."
ADMIN_EMAIL_FOR_TENANT="${ADMIN_EMAIL:-${PLATFORM_ADMIN_EMAIL:-}}"
if [[ -z "$ADMIN_EMAIL_FOR_TENANT" ]]; then
  echo "      WARNING: neither --admin-email nor PLATFORM_ADMIN_EMAIL — skipping admin elevation."
else
  POSTGRES_POD=$(kubectl get pod -n cip-infra -l app.kubernetes.io/name=postgresql \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")
  if [[ -z "$POSTGRES_POD" || -z "${PG_USER_PASSWORD:-}" ]]; then
    echo "      WARNING: postgres pod or PG_USER_PASSWORD missing — skipping admin elevation."
  else
    # Step 1: DB-side
    kubectl exec -i -n cip-infra "$POSTGRES_POD" -- \
      env PGPASSWORD="$PG_USER_PASSWORD" psql -U cipuser -d cip_hr -v ON_ERROR_STOP=1 <<SQL 2>&1 \
        | sed 's/^/      /' || true
DO \$\$
DECLARE
  v_tenant_id   UUID := '${TENANT_ID}';
  v_email       TEXT := '${ADMIN_EMAIL_FOR_TENANT}';
  v_employee_id UUID;
  v_role_id     UUID;
BEGIN
  SELECT id INTO v_role_id
    FROM roles WHERE tenant_id = v_tenant_id AND code = 'hr-service-admin';
  IF v_role_id IS NULL THEN
    RAISE NOTICE 'hr-service-admin role not seeded for tenant — re-run init-tenant-database';
    RETURN;
  END IF;
  SELECT id INTO v_employee_id
    FROM employees WHERE tenant_id = v_tenant_id AND lower(email) = lower(v_email);
  IF v_employee_id IS NULL THEN
    INSERT INTO employees (tenant_id, email, full_name, identity_type, employment_type)
    VALUES (v_tenant_id, v_email, v_email, 'aad_federated', 'employee')
    RETURNING id INTO v_employee_id;
    RAISE NOTICE 'Created admin employee row id=%', v_employee_id;
  END IF;
  INSERT INTO employee_role_assignments (employee_id, role_id, granted_by)
  VALUES (v_employee_id, v_role_id, NULL)
  ON CONFLICT DO NOTHING;
  RAISE NOTICE 'CIP role assigned: email=% tenant=% role=hr-service-admin', v_email, v_tenant_id;
END \$\$;
SQL

    # Step 2: KC realm role grant in the tenant's own realm.
    KC_USER_ID=$(curl -s "${KC_LOCAL}/admin/realms/${REALM}/users?email=${ADMIN_EMAIL_FOR_TENANT}" \
      -H "Authorization: Bearer $KC_ADMIN_TOKEN" 2>/dev/null | jq -r '.[0].id // empty')
    if [[ -z "$KC_USER_ID" ]]; then
      echo "      KC user with email=${ADMIN_EMAIL_FOR_TENANT} not found yet — sync_employee will grant `hr` on first login."
    else
      HR_ROLE_REP=$(curl -s "${KC_LOCAL}/admin/realms/${REALM}/roles/hr" \
        -H "Authorization: Bearer $KC_ADMIN_TOKEN" 2>/dev/null)
      curl -s -o /dev/null -w "      KC hr realm role grant: HTTP %{http_code}\n" \
        -X POST "${KC_LOCAL}/admin/realms/${REALM}/users/${KC_USER_ID}/role-mappings/realm" \
        -H "Authorization: Bearer $KC_ADMIN_TOKEN" \
        -H "Content-Type: application/json" \
        -d "[$HR_ROLE_REP]"
    fi
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
  max_budget:      \$$MAX_BUDGET / 30 days
  rpm_limit:       $RPM_LIMIT
  allowed models:  $(echo "$MODELS" | jq -r 'join(", ")' 2>/dev/null || echo "$MODELS")
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
