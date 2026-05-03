#!/usr/bin/env bash
# Slice 55: list which tools have an extractor vs which only have planner support.
# Cross-references the registered MCP catalog (live, via /admin/tool-metadata)
# with the local extractor registry.

set -euo pipefail

REGISTRY_FILE="packages/teams-bot/src/intent/extractors/index.ts"

if [[ ! -f "$REGISTRY_FILE" ]]; then
  echo "ERROR: $REGISTRY_FILE not found — run from repo root."
  exit 1
fi

echo "=== Tools with an extractor (Slice 55) ==="
# Pull the keys of the EXTRACTORS record — they're the tool names.
grep -oE "^\s+[a-z_]+:\s+[a-z_]+Extractor," "$REGISTRY_FILE" \
  | sed -E 's/^\s+([a-z_]+):.*/\1/' \
  | sort -u \
  | sed 's/^/  ✓ /'

echo ""
echo "=== Live MCP tool catalog (via hr-service /admin/tool-metadata) ==="
echo "    To check which tools have NO extractor yet, run:"
echo "    kubectl exec -n cip-app deploy/teams-bot -- node -e \"fetch('http://hr-service.cip-app.svc.cluster.local:3000/admin/tool-metadata',{headers:{'x-platform-admin-token':process.env.PLATFORM_ADMIN_TOKEN}}).then(r=>r.json()).then(d=>console.log(Object.keys(d.tools).sort().join('\\n')))\""
echo ""
echo "    Tools listed there but missing from the ✓ list above are routed via the planner only."
