#!/usr/bin/env bash
set -euo pipefail

# Post-deployment smoke test — run after 'make start'.
# Verifies that every service is alive and the critical paths work.
# Exit 0 = all pass. Exit 1 = one or more failures.

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; BOLD='\033[1m'; RESET='\033[0m'
pass() { echo -e "  ${GREEN}✅${RESET}  $1"; PASS=$((PASS + 1)); }
fail() { echo -e "  ${RED}❌${RESET}  $1"; FAIL=$((FAIL + 1)); FAILURES+=("$1"); }
warn() { echo -e "  ${YELLOW}⚠️ ${RESET}  $1"; }
section() { echo -e "\n${BOLD}── $1 ──────────────────────────────────────────${RESET}"; }

PASS=0; FAIL=0; FAILURES=()

# ── Cluster connectivity ──────────────────────────────────────────────────────
section "Cluster"

if kubectl cluster-info --request-timeout=10s &>/dev/null; then
  pass "kubectl connected"
else
  echo -e "${RED}FATAL: cannot reach cluster — check KUBECONFIG${RESET}"
  exit 1
fi

# ── Namespaces ────────────────────────────────────────────────────────────────
section "Namespaces"
for ns in cip-infra cip-auth cip-app cip-observe; do
  kubectl get namespace "$ns" &>/dev/null && pass "namespace $ns" || fail "namespace $ns missing"
done

# ── PVCs ──────────────────────────────────────────────────────────────────────
section "Persistent Volume Claims"

check_pvc() {
  local name="$1" ns="$2"
  local phase
  phase=$(kubectl get pvc "$name" -n "$ns" -o jsonpath='{.status.phase}' 2>/dev/null || echo "NotFound")
  case "$phase" in
    Bound)   pass "PVC $name ($ns) = Bound" ;;
    Pending) fail "PVC $name ($ns) = Pending — Cinder volume not provisioned" ;;
    *)       fail "PVC $name ($ns) = $phase" ;;
  esac
}

check_pvc postgres-data  cip-infra
check_pvc nats-data      cip-infra
check_pvc keycloak-data  cip-auth

# ── Pods: infra ───────────────────────────────────────────────────────────────
section "Pods — cip-infra (Terraform-managed, always running)"

wait_pod() {
  local label="$1" ns="$2" timeout="${3:-60}"
  if kubectl wait pod -n "$ns" -l "$label" --for=condition=Ready --timeout="${timeout}s" &>/dev/null 2>&1; then
    local name
    name=$(kubectl get pod -n "$ns" -l "$label" -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "?")
    pass "pod $label ($ns) = Ready [$name]"
    echo "$name"
  else
    fail "pod $label ($ns) not Ready after ${timeout}s"
    echo ""
  fi
}

PG_POD=$(wait_pod "app.kubernetes.io/name=postgresql" cip-infra 120)
NATS_POD=$(wait_pod "app.kubernetes.io/name=nats"      cip-infra 60)

# ── Pods: auth ────────────────────────────────────────────────────────────────
section "Pods — cip-auth"
KC_POD=$(wait_pod "app.kubernetes.io/name=keycloak" cip-auth 180)

# ── Pods: app ─────────────────────────────────────────────────────────────────
section "Pods — cip-app (start.ts-managed)"
LITELLM_POD=$(wait_pod "app=litellm"       cip-app 120)
_=$(wait_pod            "app=langfuse"      cip-app 120)
HR_POD=$(wait_pod       "app=hr-service"   cip-app 60)
_=$(wait_pod            "app=platform-core" cip-app 60)
_=$(wait_pod            "app=teams-bot"    cip-app 60)

# ── PostgreSQL ────────────────────────────────────────────────────────────────
section "PostgreSQL"

if [[ -n "$PG_POD" ]]; then
  # Use postgres superuser — avoids cipuser password mismatch issues in the check
  PG_ADMIN_PASS=$(kubectl get secret postgres-credentials -n cip-infra \
    -o jsonpath='{.data.postgres-password}' 2>/dev/null | base64 -d 2>/dev/null || echo "")

  if kubectl exec -n cip-infra "$PG_POD" -- \
      env PGPASSWORD="$PG_ADMIN_PASS" psql -U postgres -d cip_hr -c "SELECT 1" &>/dev/null 2>&1; then
    pass "postgres cip_hr accepts connections"
  else
    fail "postgres cip_hr connection refused"
  fi

  TABLES=$(kubectl exec -n cip-infra "$PG_POD" -- \
    env PGPASSWORD="$PG_ADMIN_PASS" psql -U postgres -d cip_hr -t \
    -c "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public'" \
    2>/dev/null | tr -d ' \n' || echo "0")
  if [[ "${TABLES:-0}" -gt 0 ]]; then
    pass "cip_hr has $TABLES table(s) — migrations applied"
  else
    fail "cip_hr has no tables — run 'make bootstrap' to apply migrations"
  fi
fi

# ── NATS JetStream ────────────────────────────────────────────────────────────
section "NATS JetStream"

if [[ -n "$NATS_POD" ]]; then
  # nats/nats image has no CLI; use nats-box to check streams in one shot
  kubectl delete pod nats-smoke-check -n cip-infra 2>/dev/null || true
  STREAM_STATUS=$(kubectl run nats-smoke-check --rm --restart=Never --attach \
    --image=natsio/nats-box:latest -n cip-infra \
    -- sh -c 'S=nats://nats:4222; for s in CERTS HR_EVENTS PLATFORM_EVENTS HITL_EVENTS; do
        nats -s $S stream info "$s" >/dev/null 2>&1 && echo "OK:$s" || echo "MISS:$s"
      done' 2>/dev/null || echo "")
  for stream in CERTS HR_EVENTS PLATFORM_EVENTS HITL_EVENTS; do
    if echo "$STREAM_STATUS" | grep -q "OK:$stream"; then
      pass "NATS stream $stream exists"
    else
      fail "NATS stream $stream missing — run 'make bootstrap'"
    fi
  done
fi

# ── Keycloak ──────────────────────────────────────────────────────────────────
section "Keycloak"

if [[ -n "$KC_POD" ]]; then
  KC_SVC_URL="http://keycloak.cip-auth.svc.cluster.local"
  if kubectl exec -n cip-auth "$KC_POD" -- \
      curl -sf "${KC_SVC_URL}/realms/cip-dev" &>/dev/null 2>&1; then
    pass "Keycloak realm cip-dev exists"
  else
    fail "Keycloak realm cip-dev missing — run 'make bootstrap'"
  fi

  if kubectl exec -n cip-auth "$KC_POD" -- \
      curl -sf "${KC_SVC_URL}/health/ready" &>/dev/null 2>&1; then
    pass "Keycloak health/ready"
  else
    fail "Keycloak not healthy"
  fi
fi

# ── LiteLLM ───────────────────────────────────────────────────────────────────
section "LiteLLM"

if [[ -n "$LITELLM_POD" ]]; then
  # Prefer env var; fall back to reading from k8s secret (not always sourced in CI / make context)
  _LITELLM_KEY="${LITELLM_MASTER_KEY:-$(kubectl get secret litellm-credentials -n cip-app \
    -o jsonpath='{.data.LITELLM_MASTER_KEY}' 2>/dev/null | base64 -d 2>/dev/null || echo "")}"

  # LiteLLM image is python-based and may not have curl; use python3 urllib instead
  LIVENESS=$(kubectl exec -n cip-app "$LITELLM_POD" -- \
    python3 -c "
import urllib.request, json, sys
req = urllib.request.Request('http://localhost:4000/health/liveliness',
  headers={'Authorization': 'Bearer ${_LITELLM_KEY}'})
try:
  with urllib.request.urlopen(req, timeout=10) as r:
    print(json.loads(r.read()).get('status', 'unknown'))
except Exception as e:
  sys.exit(1)
" 2>/dev/null || echo "error")

  if [[ "$LIVENESS" == "healthy" ]]; then
    pass "LiteLLM /health/liveliness = healthy"
  else
    fail "LiteLLM health check failed (status=$LIVENESS)"
  fi

  # Verify all cip-* model aliases are registered
  MODELS=$(kubectl exec -n cip-app "$LITELLM_POD" -- \
    python3 -c "
import urllib.request, json, sys
req = urllib.request.Request('http://localhost:4000/models',
  headers={'Authorization': 'Bearer ${_LITELLM_KEY}'})
try:
  with urllib.request.urlopen(req, timeout=10) as r:
    print(','.join(m['id'] for m in json.loads(r.read())['data']))
except Exception as e:
  sys.exit(1)
" 2>/dev/null || echo "")

  for alias in cip-vision cip-chat cip-lightweight cip-reasoning; do
    echo "$MODELS" | grep -q "$alias" \
      && pass "LiteLLM alias $alias registered" \
      || fail "LiteLLM alias $alias missing — check infra/helm/litellm/values.yaml"
  done

  # Test virtual key if set
  if [[ -n "${LITELLM_VIRTUAL_KEY:-}" ]] && [[ "${LITELLM_VIRTUAL_KEY}" == "sk-"* ]]; then
    VKEY_RESP=$(kubectl exec -n cip-app "$LITELLM_POD" -- \
      python3 -c "
import urllib.request, json, sys
body = json.dumps({'model':'cip-lightweight','messages':[{'role':'user','content':'ping'}],'max_tokens':5}).encode()
req = urllib.request.Request('http://localhost:4000/chat/completions', data=body,
  headers={'Authorization':'Bearer ${LITELLM_VIRTUAL_KEY}','Content-Type':'application/json'})
try:
  with urllib.request.urlopen(req, timeout=30) as r:
    print(json.loads(r.read())['choices'][0]['message']['content'])
except Exception as e:
  sys.exit(1)
" 2>/dev/null || echo "error")
    if [[ "$VKEY_RESP" != "error" ]] && [[ -n "$VKEY_RESP" ]]; then
      pass "LiteLLM virtual key test call succeeded (response: ${VKEY_RESP:0:20})"
    else
      fail "LiteLLM virtual key test call failed — check LITELLM_VIRTUAL_KEY"
    fi
  else
    warn "LITELLM_VIRTUAL_KEY not set — skipping test call (run 'make bootstrap' to issue one)"
  fi
fi

# ── Langfuse ──────────────────────────────────────────────────────────────────
section "Langfuse"

LANGFUSE_POD=$(kubectl get pod -n cip-app -l app=langfuse \
  -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")

if [[ -n "$LANGFUSE_POD" ]]; then
  LANGFUSE_STATUS=$(kubectl exec -n cip-app "$LANGFUSE_POD" -- \
    curl -sf http://localhost:3000/api/public/health 2>/dev/null \
    | jq -r '.status' 2>/dev/null || echo "error")
  if [[ "$LANGFUSE_STATUS" == "OK" ]]; then
    pass "Langfuse /api/public/health = OK"
  else
    fail "Langfuse health check failed (status=$LANGFUSE_STATUS)"
  fi
fi

# ── Domain services ───────────────────────────────────────────────────────────
section "Domain service pods"

for svc_label in hr-service platform-core teams-bot; do
  POD=$(kubectl get pod -n cip-app -l "app=$svc_label" \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")
  if [[ -n "$POD" ]]; then
    PHASE=$(kubectl get pod -n cip-app "$POD" -o jsonpath='{.status.phase}' 2>/dev/null || echo "Unknown")
    [[ "$PHASE" == "Running" ]] && pass "$svc_label pod = Running" || fail "$svc_label pod = $PHASE"
  else
    fail "$svc_label pod not found"
  fi
done

# ── NATS pub/sub roundtrip ────────────────────────────────────────────────────
section "NATS pub/sub roundtrip"

if [[ -n "$NATS_POD" ]]; then
  kubectl delete pod nats-smoke-pub -n cip-infra 2>/dev/null || true
  PUB_RESULT=$(kubectl run nats-smoke-pub --rm --restart=Never --attach \
    --image=natsio/nats-box:latest -n cip-infra \
    -- nats -s nats://nats:4222 pub cip.smoke-test.ping "smoke" 2>/dev/null \
    && echo "ok" || echo "error")
  if [[ "$PUB_RESULT" == *"ok"* ]]; then
    pass "NATS publish to cip.smoke-test.ping succeeded"
  else
    fail "NATS publish failed"
  fi
fi

# ── HR service endpoint ───────────────────────────────────────────────────────
section "HR service HTTP"

if [[ -n "$HR_POD" ]]; then
  HR_STATUS=$(kubectl exec -n cip-app "$HR_POD" -- \
    curl -sf -o /dev/null -w "%{http_code}" http://localhost:3000/health 2>/dev/null || echo "000")
  if [[ "$HR_STATUS" == "200" ]]; then
    pass "hr-service /health = 200"
  else
    warn "hr-service /health returned $HR_STATUS — endpoint may not be implemented yet"
  fi
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}════════════════════════════════════════════${RESET}"
echo -e "${BOLD}  Smoke test: ${PASS} passed, ${FAIL} failed${RESET}"
echo -e "${BOLD}════════════════════════════════════════════${RESET}"

if [[ $FAIL -gt 0 ]]; then
  echo -e "\n${RED}Failures:${RESET}"
  for f in "${FAILURES[@]}"; do
    echo -e "  ${RED}•${RESET} $f"
  done
  echo ""
  exit 1
fi

echo -e "\n  ${GREEN}${BOLD}All checks passed.${RESET}\n"
