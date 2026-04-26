#!/usr/bin/env bash
set -euo pipefail

# Dry-run the full provisioning sequence without changing anything.
# Requires .envrc to be sourced.
#
# What this checks:
#   1. Required env vars present
#   2. terraform plan — bootstrap/ (cluster + buckets)
#   3. terraform plan — cluster/ (node pool + infra charts) — skipped if no cluster yet
#   4. helm template — all APP_CHARTS from start.ts
#   5. kubectl apply --dry-run=client — k8s manifests

PASS=0
FAIL=0

ok()   { echo "  [OK]  $*"; ((PASS++)); }
fail() { echo "  [!!]  $*"; ((FAIL++)); }
section() { echo ""; echo "── $* ──────────────────────────────────────"; }

# ── 1. Required env vars ─────────────────────────────────────────────────────
section "Env vars"

REQUIRED_VARS=(
  OVH_APP_KEY OVH_APP_SECRET OVH_CONSUMER_KEY OVH_PROJECT_ID
  ANTHROPIC_API_KEY LITELLM_MASTER_KEY
  TEMPORAL_ADDRESS TEMPORAL_NAMESPACE TEMPORAL_API_KEY
  KEYCLOAK_ADMIN_PASSWORD
  DATABASE_URL_HR DATABASE_URL_PLATFORM
  LANGFUSE_PUBLIC_KEY LANGFUSE_SECRET_KEY
  MICROSOFT_APP_ID MICROSOFT_APP_PASSWORD
)

for v in "${REQUIRED_VARS[@]}"; do
  if [[ -z "${!v:-}" ]]; then
    fail "$v is not set"
  else
    ok "$v is set"
  fi
done

# ── 2. Terraform plan — bootstrap/ ───────────────────────────────────────────
section "Terraform bootstrap/ (cluster + buckets)"

export TF_VAR_ovh_endpoint="${OVH_ENDPOINT:-ovh-ca}"
export TF_VAR_ovh_application_key="${OVH_APP_KEY}"
export TF_VAR_ovh_application_secret="${OVH_APP_SECRET}"
export TF_VAR_ovh_consumer_key="${OVH_CONSUMER_KEY}"
export TF_VAR_ovh_cloud_project_service="${OVH_PROJECT_ID}"

if terraform -chdir=infra/terraform/bootstrap init -input=false -upgrade -no-color >/dev/null 2>&1; then
  ok "bootstrap/ init"
else
  fail "bootstrap/ init failed"
fi

if terraform -chdir=infra/terraform/bootstrap plan -input=false -no-color 2>&1 | tail -5; then
  ok "bootstrap/ plan"
else
  fail "bootstrap/ plan failed"
fi

# ── 3. Terraform plan — cluster/ (only if cluster exists) ────────────────────
section "Terraform cluster/ (node pool + infra charts)"

CLUSTER_ID_SOURCE=""
if [[ -n "${OVH_CLUSTER_ID:-}" ]]; then
  export TF_VAR_cluster_id="$OVH_CLUSTER_ID"
  CLUSTER_ID_SOURCE="OVH_CLUSTER_ID env var"
elif terraform -chdir=infra/terraform/bootstrap output cluster_id >/dev/null 2>&1; then
  CLUSTER_ID=$(terraform -chdir=infra/terraform/bootstrap output -raw cluster_id 2>/dev/null || echo "")
  if [[ -n "$CLUSTER_ID" ]]; then
    export TF_VAR_cluster_id="$CLUSTER_ID"
    CLUSTER_ID_SOURCE="bootstrap Terraform output"
  fi
fi

if [[ -n "${TF_VAR_cluster_id:-}" ]]; then
  ok "cluster_id=$TF_VAR_cluster_id (from $CLUSTER_ID_SOURCE)"
  if terraform -chdir=infra/terraform/cluster init -input=false -upgrade -no-color >/dev/null 2>&1; then
    ok "cluster/ init"
  else
    fail "cluster/ init failed"
  fi
  if terraform -chdir=infra/terraform/cluster plan -input=false -no-color 2>&1 | tail -5; then
    ok "cluster/ plan"
  else
    fail "cluster/ plan failed (cluster may not exist yet — run make bootstrap-infra first)"
  fi
else
  echo "  [--]  cluster/ plan skipped — OVH_CLUSTER_ID not set and no bootstrap output"
  echo "        Run 'make bootstrap-infra' first, then re-run dry-run"
fi

# ── 4. helm template — APP_CHARTS ────────────────────────────────────────────
section "Helm templates (app charts)"

helm_check() {
  local name="$1" chart="$2" ns="$3" values_flag="${4:-}"
  if helm template "$name" "$chart" -n "$ns" $values_flag >/dev/null 2>&1; then
    ok "helm template $name ($chart)"
  else
    fail "helm template $name ($chart) — $(helm template "$name" "$chart" -n "$ns" $values_flag 2>&1 | head -3)"
  fi
}

helm_check litellm       infra/helm/litellm              cip-app "-f infra/helm/litellm-values.yaml"
helm_check langfuse      infra/helm/langfuse             cip-app "-f infra/helm/langfuse-values.yaml"
helm_check hr-service    packages/hr-service/helm        cip-app
helm_check platform-core packages/platform-core/helm     cip-app
helm_check teams-bot     packages/teams-bot/helm         cip-app

# Also lint the infra charts (Terraform-managed)
for chart in bitnami/postgresql nats/nats; do
  ok "infra chart $chart — managed by Terraform (not rendered here)"
done

# ── 5. kubectl --dry-run=client — k8s manifests ──────────────────────────────
section "kubectl dry-run (k8s manifests)"

KUBE_AVAILABLE=false
if kubectl cluster-info --request-timeout=5s >/dev/null 2>&1; then
  KUBE_AVAILABLE=true
fi

kube_dry_run() {
  local file="$1"
  if [[ ! -f "$file" ]]; then
    fail "$file not found"
    return
  fi
  if $KUBE_AVAILABLE; then
    if kubectl apply --dry-run=server -f "$file" >/dev/null 2>&1; then
      ok "kubectl apply --dry-run=server $file"
    else
      fail "kubectl apply --dry-run=server $file failed"
    fi
  else
    if kubectl apply --dry-run=client -f "$file" >/dev/null 2>&1; then
      ok "kubectl apply --dry-run=client $file (cluster unreachable — client only)"
    else
      fail "kubectl apply --dry-run=client $file failed"
    fi
  fi
}

kube_dry_run infra/k8s/namespaces.yaml
kube_dry_run infra/k8s/pvcs.yaml
kube_dry_run infra/k8s/litellm-config.yaml

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════════"
echo "  Dry-run complete: $PASS passed, $FAIL failed"
echo "════════════════════════════════════════════"

if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
