#!/usr/bin/env bash
# Slice 55: scaffold a new extractor file + test stub for a given tool.
#   bash scripts/extractor-scaffold.sh employee_create

set -euo pipefail

TOOL="${1:-}"
[[ -z "$TOOL" ]] && { echo "Usage: $0 <tool_name>"; exit 1; }

# Convert snake_case → camelCase for the export name
CAMEL=$(echo "$TOOL" | awk -F_ '{for(i=1;i<=NF;i++)printf "%s%s",(i==1?$i:toupper(substr($i,1,1)) substr($i,2)),""}')

DIR="packages/teams-bot/src/intent/extractors"
FILE="$DIR/${TOOL//_/-}.ts"

if [[ -f "$FILE" ]]; then
  echo "ERROR: $FILE already exists"
  exit 1
fi

cat > "$FILE" <<EOF
// Slice 55: extractor for \`${TOOL}\`.
//
// Tool args: TODO — fill in by reading the tool's input schema from
//   packages/hr-service/src/modules/.../mcp-tools/${TOOL//_/-}.tool.ts
//
// Strategy: TODO

import type { Extractor, ExtractionResult } from './types.js';

export const ${CAMEL}Extractor: Extractor = {
  toolName: '${TOOL}',
  async extract(_text, _ctx, _deps): Promise<ExtractionResult> {
    // TODO: implement extraction
    return { kind: 'no_match' };
  },
};
EOF

echo "Created $FILE"
echo ""
echo "Next steps:"
echo "  1. Fill in the extraction strategy."
echo "  2. Add the extractor to packages/teams-bot/src/intent/extractors/index.ts:"
echo "     import { ${CAMEL}Extractor } from './${TOOL//_/-}.js';"
echo "     EXTRACTORS.${TOOL} = ${CAMEL}Extractor;"
echo "  3. Add a grammar pattern in packages/teams-bot/src/intent/grammar/patterns.ts"
echo "     pointing to toolName: '${TOOL}'"
echo "  4. Run \`make extractor-test\` to verify."
