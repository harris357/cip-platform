#!/usr/bin/env bash
set -euo pipefail

# App-layer bootstrap — idempotent, called automatically by 'make start'.
# Can also be run standalone after 'make bootstrap-infra'.
#
# Assumes:
#   - Infra pods (postgres, nats, keycloak) are Ready
#   - .envrc has been sourced (PG_USER_PASSWORD, KEYCLOAK_ADMIN_PASSWORD, etc.)

echo "=== CIP App Bootstrap ==="

# ── 1. Database migrations ────────────────────────────────────────────────────
echo "[1/5] Running database migrations..."
POSTGRES_POD=$(kubectl get pod -n cip-infra -l app.kubernetes.io/name=postgresql \
  -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")

if [[ -z "$POSTGRES_POD" ]]; then
  echo "      ERROR: postgres pod not found — ensure infra is running"
  exit 1
fi

# Create databases if they don't exist (idempotent — data persists on the PVC)
PG_ADMIN_PASS=$(kubectl get secret postgres-credentials -n cip-infra \
  -o jsonpath='{.data.postgres-password}' | base64 -d)
echo "      Ensuring databases exist..."
kubectl exec -n cip-infra "$POSTGRES_POD" -- \
  env PGPASSWORD="$PG_ADMIN_PASS" psql -U postgres \
  -c "CREATE DATABASE cip_hr OWNER cipuser;" \
  -c "CREATE DATABASE cip_litellm OWNER cipuser;" \
  2>&1 | grep -v "already exists" | sed 's/^/      /' || true

# pgvector must be created as superuser — cipuser cannot create extensions
kubectl exec -n cip-infra "$POSTGRES_POD" -- \
  env PGPASSWORD="$PG_ADMIN_PASS" psql -U postgres -d cip_hr \
  -c "CREATE EXTENSION IF NOT EXISTS vector;" 2>&1 | sed 's/^/      /' \
  || true

# Open a temporary port-forward on 15432 (avoids collision with 'make forward')
kubectl port-forward -n cip-infra svc/postgres-postgresql 15432:5432 &>/dev/null &
PF_PID=$!
sleep 3  # wait for the tunnel to be established

DATABASE_URL_HR="postgres://cipuser:${PG_USER_PASSWORD}@localhost:15432/cip_hr" \
  pnpm --filter @cip/hr-service run migrate

kill "$PF_PID" 2>/dev/null || true
echo "      Migrations done."

# ── 2+3. NATS KV bucket + JetStream streams ───────────────────────────────────
echo "[2/5] Creating NATS KV bucket for channel registry..."
echo "[3/5] Creating NATS JetStream streams..."
# The nats/nats image does not ship the nats CLI; use nats-box instead.
kubectl delete pod nats-setup -n cip-infra 2>/dev/null || true
kubectl run nats-setup --rm -i --restart=Never --image=natsio/nats-box:latest \
  -n cip-infra -- sh -c '
    S=nats://nats:4222
    nats -s $S kv add teams-channel-registry --ttl=24h \
      && echo "KV bucket teams-channel-registry created." \
      || echo "KV bucket teams-channel-registry already exists (skipped)."
    # Subject filters must match buildSubject() output: cip.{tenantId}.{domain}.{event}.{version}
    # Each entry: NAME|SUBJECTS(space-separated for --subjects flags)|RETENTION
    for entry in \
      "CERTS|cip.*.cert.>|365d" \
      "HR_EVENTS|cip.*.employee.> cip.*.worker.>|90d" \
      "PLATFORM_EVENTS|cip.*.compliance.> cip.*.tenant.>|30d" \
      "HITL_EVENTS|cip.*.hitl.>|7d"; do
      name=$(echo "$entry" | cut -d"|" -f1)
      subjects_raw=$(echo "$entry" | cut -d"|" -f2)
      retention=$(echo "$entry" | cut -d"|" -f3)
      if nats -s $S stream info "$name" > /dev/null 2>&1; then
        echo "Stream $name already exists (skipped)"
        continue
      fi
      # Build --subjects flags (one per subject)
      subj_flags=""
      for s in $subjects_raw; do
        subj_flags="$subj_flags --subjects $s"
      done
      # shellcheck disable=SC2086
      if nats -s $S stream add "$name" \
             $subj_flags \
             --storage file \
             --max-age "$retention" \
             --retention limits \
             --replicas 1 \
             --discard old \
             --defaults; then
        echo "Created stream $name ($subjects_raw)"
      else
        echo "ERROR: failed to create stream $name"
      fi
    done
  ' 2>&1 | sed "s/^/      /"

# ── 4. Keycloak cip-dev realm ─────────────────────────────────────────────────
echo "[4/5] Creating Keycloak cip-dev realm..."
KC_SVC=$(kubectl get svc -n cip-auth -l app.kubernetes.io/name=keycloakx \
  --field-selector='spec.clusterIP!=None' \
  -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")

if [[ -z "$KC_SVC" ]]; then
  echo "      WARNING: Keycloak service not found — skipping realm creation"
else
  # Port-forward to avoid relying on curl inside the minimal Keycloak image (ubi9-micro has no curl)
  KC_LOCAL="http://localhost:18080/auth"
  kubectl port-forward -n cip-auth "svc/$KC_SVC" 18080:80 &>/dev/null &
  KC_PF_PID=$!
  sleep 3

  # Env var is authoritative (set at KC first boot); secret may have drifted.
  _KC_ADMIN_PASS="${KEYCLOAK_ADMIN_PASSWORD:-}"
  if [[ -z "$_KC_ADMIN_PASS" ]]; then
    _KC_ADMIN_PASS=$(kubectl get secret keycloak-credentials -n cip-auth \
      -o jsonpath='{.data.admin-password}' 2>/dev/null | base64 -d 2>/dev/null || echo "")
  fi

  KC_TOKEN_RESP=$(curl -s -X POST \
    "${KC_LOCAL}/realms/master/protocol/openid-connect/token" \
    --data-urlencode "client_id=admin-cli" \
    --data-urlencode "username=admin" \
    --data-urlencode "password=${_KC_ADMIN_PASS}" \
    --data-urlencode "grant_type=password" \
    2>/dev/null || echo "")
  KC_ADMIN_TOKEN=$(echo "$KC_TOKEN_RESP" | jq -r '.access_token' 2>/dev/null || echo "")

  if [[ -z "$KC_ADMIN_TOKEN" || "$KC_ADMIN_TOKEN" == "null" ]]; then
    KC_ERROR=$(echo "$KC_TOKEN_RESP" | jq -r '.error_description // .error // "no response"' 2>/dev/null || echo "no response")
    echo "      WARNING: could not obtain Keycloak admin token: $KC_ERROR"
    echo "      Pass length: ${#_KC_ADMIN_PASS}, URL: ${KC_LOCAL}/realms/master/protocol/openid-connect/token"
    echo "      Raw response (first 200 chars): ${KC_TOKEN_RESP:0:200}"
  else
    HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
      -X POST "${KC_LOCAL}/admin/realms" \
      -H "Authorization: Bearer $KC_ADMIN_TOKEN" \
      -H "Content-Type: application/json" \
      -d '{"realm": "cip-dev", "enabled": true, "displayName": "CIP Dev"}' \
      2>/dev/null || echo "000")
    case "$HTTP_STATUS" in
      201) echo "      Realm cip-dev created." ;;
      409) echo "      Realm cip-dev already exists (skipped)." ;;
      *)   echo "      WARNING: Keycloak realm creation returned HTTP $HTTP_STATUS" ;;
    esac

    # Create teams-bot client in cip-dev (idempotent)
    KC_CLIENT_ID=$(curl -s \
      "${KC_LOCAL}/admin/realms/cip-dev/clients?clientId=teams-bot" \
      -H "Authorization: Bearer $KC_ADMIN_TOKEN" \
      2>/dev/null | jq -r '.[0].id // empty' 2>/dev/null || echo "")

    if [[ -n "$KC_CLIENT_ID" ]]; then
      echo "      teams-bot client already exists (skipped)."
    else
      KC_CREATE_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
        -X POST "${KC_LOCAL}/admin/realms/cip-dev/clients" \
        -H "Authorization: Bearer $KC_ADMIN_TOKEN" \
        -H "Content-Type: application/json" \
        -d '{
          "clientId": "teams-bot",
          "enabled": true,
          "clientAuthenticatorType": "client-secret",
          "serviceAccountsEnabled": true,
          "publicClient": false,
          "protocol": "openid-connect",
          "standardFlowEnabled": false,
          "directAccessGrantsEnabled": false
        }' 2>/dev/null || echo "000")
      case "$KC_CREATE_STATUS" in
        201) echo "      teams-bot client created." ;;
        *)   echo "      WARNING: teams-bot client creation returned HTTP $KC_CREATE_STATUS" ;;
      esac
      KC_CLIENT_ID=$(curl -s \
        "${KC_LOCAL}/admin/realms/cip-dev/clients?clientId=teams-bot" \
        -H "Authorization: Bearer $KC_ADMIN_TOKEN" \
        2>/dev/null | jq -r '.[0].id // empty' 2>/dev/null || echo "")
    fi

    # Retrieve client secret and patch K8s secret (idempotent)
    if [[ -n "$KC_CLIENT_ID" ]]; then
      KC_CLIENT_SECRET=$(curl -s \
        "${KC_LOCAL}/admin/realms/cip-dev/clients/${KC_CLIENT_ID}/client-secret" \
        -H "Authorization: Bearer $KC_ADMIN_TOKEN" \
        2>/dev/null | jq -r '.value // empty' 2>/dev/null || echo "")

      if [[ -n "$KC_CLIENT_SECRET" ]]; then
        kubectl patch secret teams-bot-credentials -n cip-app \
          --type=merge \
          -p "{\"data\":{\"KEYCLOAK_CLIENT_SECRET\":\"$(echo -n "$KC_CLIENT_SECRET" | base64 -w0)\"}}" \
          2>/dev/null \
          && echo "      KEYCLOAK_CLIENT_SECRET patched into teams-bot-credentials." \
          || echo "      ACTION REQUIRED: teams-bot-credentials secret not found — add KEYCLOAK_CLIENT_SECRET=$KC_CLIENT_SECRET manually"
      else
        echo "      WARNING: could not retrieve teams-bot client secret"
      fi
    fi

    # Create bot-auto-create first broker login flow (idempotent).
    # Two steps, no browser required: create new user OR silently link existing user by email.
    _FLOW_EXISTS=$(curl -s \
      "${KC_LOCAL}/admin/realms/cip-dev/authentication/flows" \
      -H "Authorization: Bearer $KC_ADMIN_TOKEN" 2>/dev/null \
      | jq -r '.[] | select(.alias == "bot-auto-create") | .alias' 2>/dev/null || echo "")

    if [[ -n "$_FLOW_EXISTS" ]]; then
      echo "      bot-auto-create flow already exists (skipped)."
    else
      curl -s -o /dev/null -w "      bot-auto-create flow: HTTP %{http_code}\n" \
        -X POST "${KC_LOCAL}/admin/realms/cip-dev/authentication/flows" \
        -H "Authorization: Bearer $KC_ADMIN_TOKEN" \
        -H "Content-Type: application/json" \
        -d '{
          "alias": "bot-auto-create",
          "description": "Auto-creates KC users from external IDP tokens without browser interaction",
          "providerId": "basic-flow",
          "topLevel": true,
          "builtIn": false
        }' 2>/dev/null

      # Add executions: Create User If Unique, then Automatically Set Existing User
      curl -s -o /dev/null \
        -X POST "${KC_LOCAL}/admin/realms/cip-dev/authentication/flows/bot-auto-create/executions/execution" \
        -H "Authorization: Bearer $KC_ADMIN_TOKEN" \
        -H "Content-Type: application/json" \
        -d '{"provider": "idp-create-user-if-unique"}' 2>/dev/null
      curl -s -o /dev/null \
        -X POST "${KC_LOCAL}/admin/realms/cip-dev/authentication/flows/bot-auto-create/executions/execution" \
        -H "Authorization: Bearer $KC_ADMIN_TOKEN" \
        -H "Content-Type: application/json" \
        -d '{"provider": "idp-auto-link"}' 2>/dev/null

      # Set both executions to ALTERNATIVE
      _EXECS_JSON=$(curl -s \
        "${KC_LOCAL}/admin/realms/cip-dev/authentication/flows/bot-auto-create/executions" \
        -H "Authorization: Bearer $KC_ADMIN_TOKEN" 2>/dev/null || echo "[]")
      while IFS= read -r _EXEC; do
        curl -s -o /dev/null \
          -X PUT "${KC_LOCAL}/admin/realms/cip-dev/authentication/flows/bot-auto-create/executions" \
          -H "Authorization: Bearer $KC_ADMIN_TOKEN" \
          -H "Content-Type: application/json" \
          -d "$(echo "$_EXEC" | jq '.requirement = "ALTERNATIVE"')" 2>/dev/null
      done < <(echo "$_EXECS_JSON" | jq -c '.[]' 2>/dev/null)

      echo "      bot-auto-create flow configured."
    fi

    # Configure AAD identity provider + token exchange (idempotent)
    _BOT_APP_ID="${BOT_APP_ID:-}"
    _TENANT_ID="${TENANT_ID:-}"
    _BOT_APP_PASSWORD=$(kubectl get secret teams-bot-credentials -n cip-app \
      -o jsonpath='{.data.BOT_APP_PASSWORD}' 2>/dev/null | base64 -d 2>/dev/null || echo "")

    if [[ -z "$_BOT_APP_ID" || -z "$_TENANT_ID" || -z "$_BOT_APP_PASSWORD" ]]; then
      echo "      WARNING: BOT_APP_ID, TENANT_ID, or BOT_APP_PASSWORD missing — skipping AAD IDP setup"
      echo "      Ensure BOT_APP_ID and TENANT_ID are exported in .envrc"
    else
      # Create AAD OIDC identity provider
      _AAD_EXISTS=$(curl -s \
        "${KC_LOCAL}/admin/realms/cip-dev/identity-provider/instances/aad" \
        -H "Authorization: Bearer $KC_ADMIN_TOKEN" \
        2>/dev/null | jq -r '.alias // empty' 2>/dev/null || echo "")

      if [[ -n "$_AAD_EXISTS" ]]; then
        echo "      AAD identity provider already exists (skipped)."
      else
        _IDP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
          -X POST "${KC_LOCAL}/admin/realms/cip-dev/identity-provider/instances" \
          -H "Authorization: Bearer $KC_ADMIN_TOKEN" \
          -H "Content-Type: application/json" \
          -d "{
            \"alias\": \"aad\",
            \"displayName\": \"Microsoft AAD\",
            \"providerId\": \"oidc\",
            \"enabled\": true,
            \"firstBrokerLoginFlowAlias\": \"bot-auto-create\",
            \"config\": {
              \"clientId\": \"${_BOT_APP_ID}\",
              \"clientSecret\": \"${_BOT_APP_PASSWORD}\",
              \"tokenUrl\": \"https://login.microsoftonline.com/${_TENANT_ID}/oauth2/v2.0/token\",
              \"authorizationUrl\": \"https://login.microsoftonline.com/${_TENANT_ID}/oauth2/v2.0/authorize\",
              \"jwksUrl\": \"https://login.microsoftonline.com/${_TENANT_ID}/discovery/v2.0/keys\",
              \"validateSignature\": \"true\",
              \"useJwksUrl\": \"true\",
              \"issuer\": \"https://login.microsoftonline.com/${_TENANT_ID}/v2.0\",
              \"defaultScope\": \"openid profile email\",
              \"syncMode\": \"IMPORT\"
            }
          }" 2>/dev/null || echo "000")
        case "$_IDP_STATUS" in
          201) echo "      AAD identity provider created." ;;
          *)   echo "      WARNING: AAD IDP creation returned HTTP $_IDP_STATUS" ;;
        esac
      fi

      # Configure JWT Authorization Grant on aad IDP (idempotent — applies whether IDP was just created or already existed).
      # jwtAuthorizationGrantEnabled: allows incoming JWT assertions to be exchanged for Keycloak tokens.
      # allowClientIdAsAudience: AAD tokens have aud=<app-id> (not KC issuer URL) — this accepts that.
      _IDP_JSON=$(curl -s \
        "${KC_LOCAL}/admin/realms/cip-dev/identity-provider/instances/aad" \
        -H "Authorization: Bearer $KC_ADMIN_TOKEN" 2>/dev/null || echo "{}")
      _IDP_UPDATED=$(echo "$_IDP_JSON" | jq '
        .config.jwtAuthorizationGrantEnabled = "true" |
        .config.allowClientIdAsAudience = "true" |
        .config.jwtAuthorizationGrantMaxAllowedAssertionExpiration = "14400" |
        .config.supportsClientAssertionReuse = "true" |
        .firstBrokerLoginFlowAlias = "bot-auto-create"
      ' 2>/dev/null || echo "{}")
      curl -s -o /dev/null -w "      AAD IDP JWT grant settings: HTTP %{http_code}\n" \
        -X PUT "${KC_LOCAL}/admin/realms/cip-dev/identity-provider/instances/aad" \
        -H "Authorization: Bearer $KC_ADMIN_TOKEN" \
        -H "Content-Type: application/json" \
        -d "$_IDP_UPDATED" 2>/dev/null

      # Enable JWT Authorization Grant on teams-bot client (idempotent).
      # oauth2.jwt.authorization.grant.enabled: client may use the jwt-bearer grant type.
      # oauth2.jwt.authorization.grant.idp: restrict to assertions from the aad IDP only.
      if [[ -n "$KC_CLIENT_ID" ]]; then
        _CLIENT_JSON=$(curl -s \
          "${KC_LOCAL}/admin/realms/cip-dev/clients/${KC_CLIENT_ID}" \
          -H "Authorization: Bearer $KC_ADMIN_TOKEN" 2>/dev/null || echo "{}")
        _CLIENT_UPDATED=$(echo "$_CLIENT_JSON" | jq '
          .attributes["oauth2.jwt.authorization.grant.enabled"] = "true" |
          .attributes["oauth2.jwt.authorization.grant.idp"] = "aad"
        ' 2>/dev/null || echo "{}")
        curl -s -o /dev/null -w "      teams-bot JWT grant config: HTTP %{http_code}\n" \
          -X PUT "${KC_LOCAL}/admin/realms/cip-dev/clients/${KC_CLIENT_ID}" \
          -H "Authorization: Bearer $KC_ADMIN_TOKEN" \
          -H "Content-Type: application/json" \
          -d "$_CLIENT_UPDATED" 2>/dev/null
      fi

      # AAD IDP mapper: use the Entra `oid` claim as the federation key
      # (BROKER_ID), instead of the default `sub`. Entra v2 `sub` is pairwise
      # per-app; `oid` is global per tenant and what our admin tooling stores
      # when provisioning a federated employee. Idempotent — skip if exists.
      _OID_MAPPER_NAME="aad-oid-as-user-id"
      _OID_MAPPER_EXISTS=$(curl -s \
        "${KC_LOCAL}/admin/realms/cip-dev/identity-provider/instances/aad/mappers" \
        -H "Authorization: Bearer $KC_ADMIN_TOKEN" 2>/dev/null \
        | jq -r --arg n "$_OID_MAPPER_NAME" '.[] | select(.name==$n) | .name' 2>/dev/null || echo "")
      if [[ -z "$_OID_MAPPER_EXISTS" ]]; then
        curl -s -o /dev/null -w "      AAD oid→BROKER_ID mapper: HTTP %{http_code}\n" \
          -X POST "${KC_LOCAL}/admin/realms/cip-dev/identity-provider/instances/aad/mappers" \
          -H "Authorization: Bearer $KC_ADMIN_TOKEN" \
          -H "Content-Type: application/json" \
          -d "{
            \"name\": \"${_OID_MAPPER_NAME}\",
            \"identityProviderAlias\": \"aad\",
            \"identityProviderMapper\": \"oidc-username-idp-mapper\",
            \"config\": {
              \"template\":  \"\${CLAIM.oid}\",
              \"target\":    \"BROKER_ID\",
              \"syncMode\":  \"FORCE\"
            }
          }" 2>/dev/null
      else
        echo "      AAD oid→BROKER_ID mapper already exists (skipped)."
      fi
    fi

    # Protocol Mapper on the teams-bot client: emit a hardcoded tenantId claim
    # on every token KC issues for this client. Internal services (hr-service
    # MCP tools etc.) read this claim for tenant scoping; without it, every
    # tool call fails with "JWT missing tenantId claim".
    #
    # Value is the dev tenant UUID — for prod realms, provision-tenant.sh
    # uses claim.value = realm name (since prod has realm == tenant.id).
    # Source of truth for the dev tenant UUID: tenants table, fixed at
    # 00000000-0000-0000-0000-000000000001 by the dev onboarding SQL.
    #
    # Mapper is attached to the CLIENT (not the realm) — KC's client-scoped
    # mappers are the reliable injection point for OIDC token claims.
    if [[ -n "$KC_CLIENT_ID" ]]; then
      _DEV_TENANT_UUID="${CIP_DEV_TENANT_UUID:-00000000-0000-0000-0000-000000000001}"
      _TENANT_MAPPER_NAME="cip-tenant-id"
      _TENANT_MAPPER_EXISTS=$(curl -s \
        "${KC_LOCAL}/admin/realms/cip-dev/clients/${KC_CLIENT_ID}/protocol-mappers/models" \
        -H "Authorization: Bearer $KC_ADMIN_TOKEN" 2>/dev/null \
        | jq -r --arg n "$_TENANT_MAPPER_NAME" '.[] | select(.name==$n) | .name' 2>/dev/null || echo "")
      if [[ -z "$_TENANT_MAPPER_EXISTS" ]]; then
        curl -s -o /dev/null -w "      tenantId client mapper: HTTP %{http_code}\n" \
          -X POST "${KC_LOCAL}/admin/realms/cip-dev/clients/${KC_CLIENT_ID}/protocol-mappers/models" \
          -H "Authorization: Bearer $KC_ADMIN_TOKEN" \
          -H "Content-Type: application/json" \
          -d "{
            \"name\": \"${_TENANT_MAPPER_NAME}\",
            \"protocol\": \"openid-connect\",
            \"protocolMapper\": \"oidc-hardcoded-claim-mapper\",
            \"config\": {
              \"claim.name\":         \"tenantId\",
              \"claim.value\":        \"${_DEV_TENANT_UUID}\",
              \"jsonType.label\":     \"String\",
              \"id.token.claim\":     \"true\",
              \"access.token.claim\": \"true\",
              \"userinfo.token.claim\":\"true\"
            }
          }" 2>/dev/null
      else
        echo "      tenantId client mapper already exists (skipped)."
      fi
    fi
  fi

  kill "$KC_PF_PID" 2>/dev/null || true
fi

# ── 5. LiteLLM dev-tenant virtual key ────────────────────────────────────────
echo "[5/5] Issuing LiteLLM virtual key for dev tenant..."
LITELLM_SVC=$(kubectl get svc litellm -n cip-app \
  -o jsonpath='{.metadata.name}' 2>/dev/null || echo "")

if [[ -z "$LITELLM_SVC" ]]; then
  echo "      WARNING: LiteLLM service not found — skipping virtual key (re-run bootstrap after start completes)"
else
  # Port-forward to avoid relying on curl inside the LiteLLM container image
  kubectl port-forward -n cip-app svc/litellm 14000:4000 &>/dev/null &
  LL_PF_PID=$!
  sleep 3

  # Always read from the K8s secret — authoritative source
  _MASTER_KEY=$(kubectl get secret litellm-credentials -n cip-app \
    -o jsonpath='{.data.LITELLM_MASTER_KEY}' 2>/dev/null | base64 -d 2>/dev/null || echo "")
  _MASTER_KEY="${_MASTER_KEY:-${LITELLM_MASTER_KEY:-}}"

  # Capture both body and HTTP status in one request
  LL_RESP=$(curl -s -w "\n%{http_code}" -X POST http://localhost:14000/key/generate \
    -H "Authorization: Bearer $_MASTER_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"key_alias\": \"dev-tenant\", \"team_id\": \"${DEV_TENANT_ID:-dev}\"}" \
    2>/dev/null || echo "")
  LL_STATUS=$(echo "$LL_RESP" | tail -1)
  LL_BODY=$(echo "$LL_RESP" | head -n -1)

  case "$LL_STATUS" in
    200|201)
      NEW_KEY=$(echo "$LL_BODY" | jq -r '.key' 2>/dev/null || echo "")
      echo "      Virtual key generated: $NEW_KEY"
      echo "      ACTION REQUIRED: add to .envrc → export LITELLM_VIRTUAL_KEY=$NEW_KEY"
      ;;
    400)
      echo "      Virtual key already exists (alias: dev-tenant — skipped)."
      echo "      To retrieve it: curl -s http://localhost:14000/key/info?key=<token> -H \"Authorization: Bearer \$LITELLM_MASTER_KEY\" | jq '.info.token'"
      ;;
    *)
      echo "      WARNING: could not generate virtual key (HTTP $LL_STATUS)"
      echo "      Response: ${LL_BODY:0:300}"
      ;;
  esac

  kill "$LL_PF_PID" 2>/dev/null || true
fi

echo ""
echo "=== Bootstrap complete ==="
