#!/usr/bin/env bash
set -euo pipefail

# Full start → smoke-test → stop cycle.
# Two modes:
#   bash scripts/cycle-test.sh          — daily cycle (scale up + app charts only)
#   bash scripts/cycle-test.sh --reprovision — also re-applies Terraform cluster/ first
#
# Run from repo root with .envrc sourced.

REPROVISION=false
[[ "${1:-}" == "--reprovision" ]] && REPROVISION=true

BOLD='\033[1m'; GREEN='\033[0;32m'; RED='\033[0;31m'; RESET='\033[0m'
log()  { echo -e "\n${BOLD}[cycle-test] $*${RESET}"; }
ok()   { echo -e "${GREEN}[cycle-test] ✅ $*${RESET}"; }
die()  { echo -e "${RED}[cycle-test] ❌ $*${RESET}"; exit 1; }

START_TIME=$(date +%s)

# ── Optional: reprovision infra Helm charts via Terraform ─────────────────────
if $REPROVISION; then
  log "Reprovisioning infra Helm charts via Terraform cluster/..."

  export TF_VAR_ovh_endpoint="${OVH_ENDPOINT:-ovh-ca}"
  export TF_VAR_ovh_application_key="$OVH_APP_KEY"
  export TF_VAR_ovh_application_secret="$OVH_APP_SECRET"
  export TF_VAR_ovh_consumer_key="$OVH_CONSUMER_KEY"
  export TF_VAR_ovh_cloud_project_service="$OVH_PROJECT_ID"

  # cluster_id: prefer env var, fall back to bootstrap output
  if [[ -n "${OVH_CLUSTER_ID:-}" ]]; then
    export TF_VAR_cluster_id="$OVH_CLUSTER_ID"
  else
    CLUSTER_ID=$(terraform -chdir=infra/terraform/bootstrap output -raw cluster_id 2>/dev/null || echo "")
    [[ -z "$CLUSTER_ID" ]] && die "OVH_CLUSTER_ID not set and no bootstrap terraform output — run 'make bootstrap-infra' first"
    export TF_VAR_cluster_id="$CLUSTER_ID"
  fi

  # Destroy only Helm releases — PVCs, namespaces, and node pool are preserved
  log "Destroying infra Helm releases (PVCs preserved)..."
  for target in helm_release.postgres helm_release.nats helm_release.keycloak helm_release.monitoring; do
    terraform -chdir=infra/terraform/cluster destroy \
      -target="$target" -input=false -auto-approve \
      2>&1 | grep -E "Destroy complete|destroyed|No changes" || true
  done

  log "Re-applying Terraform cluster/..."
  terraform -chdir=infra/terraform/cluster apply -input=false -auto-approve

  log "Re-running app bootstrap (NATS streams, Keycloak realm, migrations)..."
  bash scripts/bootstrap.sh
fi

# ── Bring up ─────────────────────────────────────────────────────────────────
log "Starting stack (make start)..."
make start || die "make start failed"
ok "Stack started"

# Wait for all cip-app pods to be Ready before running smoke test
log "Waiting for all cip-app pods to be Ready..."
kubectl wait pod -n cip-app --all --for=condition=Ready --timeout=300s \
  2>/dev/null && ok "All cip-app pods Ready" || echo "  (some pods still starting — smoke-test will report details)"

# ── Smoke test ────────────────────────────────────────────────────────────────
log "Running smoke test..."
if bash scripts/smoke-test.sh; then
  ok "Smoke test passed"
  SMOKE_RESULT=0
else
  echo -e "${RED}[cycle-test] Smoke test failed — stack left running for inspection${RESET}"
  echo "  Run 'kubectl get pods -A' to inspect state"
  echo "  Run 'make stop' when done"
  SMOKE_RESULT=1
fi

# ── Bring down ────────────────────────────────────────────────────────────────
log "Stopping stack (make stop)..."
make stop || die "make stop failed"

# Verify app pods are gone
sleep 5
REMAINING=$(kubectl get pods -n cip-app --no-headers 2>/dev/null | grep -v "Terminating" | wc -l | tr -d ' ')
if [[ "$REMAINING" -eq 0 ]]; then
  ok "All cip-app pods removed"
else
  echo "  Warning: $REMAINING pod(s) still present in cip-app (may still be terminating)"
fi

# PVCs must still exist after stop
for pvc_ns in "postgres-data:cip-infra" "nats-data:cip-infra" "keycloak-data:cip-auth"; do
  pvc="${pvc_ns%%:*}"; ns="${pvc_ns##*:}"
  phase=$(kubectl get pvc "$pvc" -n "$ns" -o jsonpath='{.status.phase}' 2>/dev/null || echo "Missing")
  [[ "$phase" == "Bound" ]] \
    && ok "PVC $pvc ($ns) still Bound after stop" \
    || echo "  Warning: PVC $pvc ($ns) = $phase after stop"
done

# ── Summary ───────────────────────────────────────────────────────────────────
END_TIME=$(date +%s)
ELAPSED=$(( END_TIME - START_TIME ))

echo ""
echo -e "${BOLD}════════════════════════════════════════════${RESET}"
echo -e "${BOLD}  Cycle test complete (${ELAPSED}s)${RESET}"
echo -e "${BOLD}════════════════════════════════════════════${RESET}"

if [[ $SMOKE_RESULT -eq 0 ]]; then
  echo -e "  ${GREEN}${BOLD}PASS — stack provisions, runs, and stops cleanly.${RESET}"
else
  echo -e "  ${RED}${BOLD}FAIL — smoke test had failures (see output above).${RESET}"
  exit 1
fi
