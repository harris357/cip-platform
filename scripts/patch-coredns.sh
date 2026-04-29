#!/usr/bin/env bash
set -euo pipefail

# Patches CoreDNS to rewrite keycloak.cip.idlevice.ca → keycloak-keycloakx.cip-auth.svc.cluster.local
# Prevents pods from hairpin-NATting through the public ingress to reach Keycloak.
# Idempotent — safe to run multiple times.

REWRITE="    rewrite name exact keycloak.cip.idlevice.ca keycloak-keycloakx.cip-auth.svc.cluster.local"

if kubectl get configmap coredns -n kube-system -o jsonpath='{.data.Corefile}' | grep -q "keycloak-keycloakx"; then
  echo "CoreDNS rewrite already present — skipping"
  exit 0
fi

TMPFILE=$(mktemp)
trap "rm -f ${TMPFILE}" EXIT

kubectl get configmap coredns -n kube-system -o json > "${TMPFILE}"

python3 << PYEOF
import json

with open('${TMPFILE}') as f:
    obj = json.load(f)

corefile = obj['data']['Corefile']
rewrite_line = "    rewrite name exact keycloak.cip.idlevice.ca keycloak-keycloakx.cip-auth.svc.cluster.local"

# Insert before the 'errors' plugin line inside the .:53 block
if rewrite_line not in corefile:
    corefile = corefile.replace("    errors", rewrite_line + "\n    errors", 1)

obj['data']['Corefile'] = corefile

with open('${TMPFILE}', 'w') as f:
    json.dump(obj, f)
PYEOF

kubectl apply -f "${TMPFILE}"
kubectl rollout restart deployment/coredns -n kube-system

echo "CoreDNS patched. Waiting for rollout..."
kubectl rollout status deployment/coredns -n kube-system --timeout=60s

echo ""
echo "Verify with:"
echo "  kubectl run dns-test --image=busybox:1.35 --rm -it --restart=Never -- nslookup keycloak.cip.idlevice.ca"
echo "Expected: returns a 10.x.x.x ClusterIP, not a public IP"
