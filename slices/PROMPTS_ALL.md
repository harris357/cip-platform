# CIP Platform — Session Prompts

One prompt per slice. Copy verbatim into Claude Code to start the session.
Each prompt is self-contained — do not load any file not listed under "Read before writing."

---

_(new prompts will be added here as slices are defined)_

---


## PROMPT Slice 37 — Per-Tenant KC Client Secrets via K8s Secrets

```
You are working on the CIP Platform TypeScript monorepo.

Session: Slice 37 — Per-Tenant KC Client Secrets via K8s Secrets + Bot Dynamic Loading
Package: @cip/teams-bot, scripts/provision-tenant.sh
Verify: pnpm --filter @cip/teams-bot typecheck && pnpm -r run typecheck

Prerequisite: Slices 35 and 36 must be complete. This slice consumes
tenant_identity_providers.secret_ref (Slice 35 schema) and replaces the
KEYCLOAK_CLIENT_SECRETS JSON-map env (Slice 36 placeholder) with K8s
secret reads via the bot's ServiceAccount.

Read before writing:
- CLAUDE.md
- slices/SLICE_37_PER_TENANT_KC_SECRETS.md   (this slice's full spec)
- slices/SLICE_36_MULTI_TENANT_BOT.md         § "Per-realm secrets"
- slices/CROSS_SLICE_NOTES.md
- docs/identity-and-auth-architecture.md      § "Configuration reference"

Goal: replace the env-var JSON-map for per-tenant KC client secrets with
real K8s secrets named `tenant-aad-<cipTenantId>`, read by the bot
dynamically via its ServiceAccount on cache miss (5-minute TTL).
Keep KEYCLOAK_CLIENT_SECRETS map + KEYCLOAK_CLIENT_SECRET single-value
env as dev-only fallback paths. provision-tenant.sh now creates the
K8s secret AND updates tenant_identity_providers.secret_ref so the bot
picks it up without a pod restart.

Files to create:
- packages/teams-bot/src/auth/k8s-secret-loader.ts
- packages/teams-bot/helm/templates/service-account.yaml

Files to modify:
- packages/teams-bot/src/auth/keycloak-secrets.ts   (resolveKcClientSecret async fn)
- packages/teams-bot/src/auth/tenant-resolver.ts    (call new resolver, new error variants)
- packages/teams-bot/helm/values.yaml               (POD_NAMESPACE downward API + SA toggle)
- packages/teams-bot/helm/templates/deployment.yaml (serviceAccountName)
- packages/teams-bot/package.json                   (add @kubernetes/client-node)
- scripts/provision-tenant.sh                       (create K8s secret + update secret_ref)

Hard rules (Seven Non-Negotiables):
- secret_ref naming convention: tenant-aad-<cipTenantId> (lowercase UUID)
- Bot ServiceAccount RBAC scoped to namespace cip-app, secrets:get only
- 5-minute in-memory cache for K8s secret reads
- Failure modes return typed errors: 'k8s_secret_not_found', 'k8s_secret_read_failed'
- No @anthropic-ai/sdk imports
- Stubs forbidden — every function ships with a working body
- Existing dev path (KEYCLOAK_CLIENT_SECRET fallback) must keep working
  for the existing dev tenant (no secret_ref set in DB)

Acceptance: see "Acceptance Criteria" in SLICE_37_PER_TENANT_KC_SECRETS.md.

If a finding requires changing earlier slice output: log a cross-slice
note per slices/CROSS_SLICE_NOTES.md and continue. Do not refactor
outside this slice.

Commit: slice(37): per-tenant KC client secrets via K8s secrets + bot dynamic loading
```

---

## PROMPT Slice 38 — Module-Level Permissions

```
You are working on the CIP Platform TypeScript monorepo.

Session: Slice 38 — Module-Level Permissions + Permission Management Tools
Package: @cip/teams-bot, @cip/hr-service
Verify: pnpm --filter @cip/teams-bot typecheck && pnpm --filter @cip/hr-service typecheck && pnpm -r run typecheck

Prerequisite: Slice 32 (realm roles 'hr' and 'employee') must be complete.
Independent of Slices 31/33/35/36/37.

Read before writing:
- CLAUDE.md
- slices/SLICE_38_PERMISSIONS.md   (this slice's full spec)
- slices/SLICE_32_REALM_ROLES_AND_AUDIT.md
- slices/CROSS_SLICE_NOTES.md
- docs/users-roles-auth-normalization-plan.md  (background — two-layer model)

Goal: Replace the empty `capabilities` plumbing with a working two-layer
access model. Realm role (Slice 32) gates which service the user can call;
permission (this slice) gates which TOOL within that service. Bot's
discoverTools filters tools by requiredPermission annotation against the
user's permission map; tool handlers also assert server-side (defense
in depth).

THIS SLICE INCLUDES A RENAME: every reference to "capabilities" /
"capability" in bot and hr-service source code becomes "permissions" /
"permission". The word "capability" must not appear in deliverables
(except in any comment that explicitly references the MCP protocol's
unrelated `capabilities` field — these are protocol-level, not auth-level).

Files to create:
- packages/hr-service/src/db/migrations/00X_role_permissions.sql
- packages/hr-service/src/db/queries/permissions.ts
- packages/hr-service/src/modules/employees/mcp-tools/get-employee-permissions.tool.ts
    (replaces / renames any existing get-employee-capabilities tool stub)
- packages/hr-service/src/modules/employees/mcp-tools/employee.grant-permission.tool.ts
- packages/hr-service/src/modules/employees/mcp-tools/employee.revoke-permission.tool.ts

Files to modify:
- packages/teams-bot/src/auth/resolve-context.ts
    rename ctx.capabilities → ctx.permissions; call get_employee_permissions
- packages/teams-bot/src/mcp/tool-discovery.ts
    annotation lookup key requiredCapability → requiredPermission
- packages/teams-bot/src/bot.ts (if it references the field directly)
- packages/hr-service/src/mcp-server/auth.ts
    add assertPermission(authInfo, code) helper (DB-backed)
- packages/hr-service/src/modules/employees/mcp-tools/sync-employee.ts
    doc-comment update
- packages/hr-service/src/modules/employees/mcp-tools/index.ts
    register new tools, drop old get_employee_capabilities registration

Hard rules (Seven Non-Negotiables):
- Permission code format: <resource>.<action>, lowercase, dots not colons
- tenantId flows through unchanged; permissions are tenant-scoped
- Defense in depth: bot discoverTools filter (UX) AND tool handler
  assertPermission (security) — both required
- Zod-validated outputs from new MCP tools
- No @anthropic-ai/sdk imports
- Stubs forbidden — every function ships with a working body
- Don't touch Slice 33's MCP tool implementations (those don't exist
  yet); when Slice 33 runs, it will declare requiredPermission against
  this slice's catalog

Acceptance: see "Acceptance Criteria" in SLICE_38_PERMISSIONS.md.

If a finding requires changing earlier slice output: log a cross-slice
note per slices/CROSS_SLICE_NOTES.md and continue. Do not refactor
outside this slice.

Commit: slice(38): module-level permissions + permission management tools
```

---

## PROMPT Slice 43 — Remove the hardcoded category layer

```
You are working on the CIP Platform TypeScript monorepo.

Session: Slice 43 — Remove the hardcoded category layer
Package: @cip/teams-bot, @cip/shared, @cip/hr-service
Verify: pnpm --filter @cip/teams-bot typecheck
        pnpm --filter @cip/shared typecheck
        pnpm --filter @cip/hr-service typecheck

Prerequisite: Slice 39B + 41 deployed. Bot is on b240cb8 (post-crash-fix).

Read before writing:
- CLAUDE.md
- slices/SLICE_43_REMOVE_CATEGORY_LAYER.md   (this slice's full spec)
- slices/CROSS_SLICE_NOTES.md
- packages/teams-bot/src/intent/tool-categories.ts  (heavy delete)
- packages/teams-bot/src/intent/classifier.ts
- packages/teams-bot/src/intent/router.ts
- packages/teams-bot/src/bot.ts
- packages/shared/src/clients/prompts/bot-intent-classify.ts
- packages/shared/src/clients/prompts/index.ts
- packages/teams-bot/src/mcp/tool-discovery.ts
- One sample MCP tool registration per module (cert/employee/admin/compliance) to inform the description sweep

Goal: collapse the six-label intent enum to three (chitchat/meta/proceed),
delete the per-category Stage-2 tool maps and aliases, restore an
LLM-composed meta reply via a dedicated meta_compose call, sweep every
hr-service tool description to the scope/audience/output shape with
requiredPermission annotations, and fix the discoverTools cache key
bug (was tenant-keyed → must be tenant+user).

Files to create:
- packages/teams-bot/src/intent/meta-compose.ts
- packages/shared/src/clients/prompts/bot-meta-compose.ts
- packages/hr-service/src/db/migrations/014_routing_rules_collapse.sql

Files to modify:
- packages/teams-bot/src/intent/tool-categories.ts  (delete most; keep 3-intent enum + availableIntents helper)
- packages/teams-bot/src/intent/classifier.ts       (3-label schema; resilient parse)
- packages/teams-bot/src/intent/router.ts           (single alias=route, full permitted catalog)
- packages/teams-bot/src/intent/debug-banner.ts     (rename category → intent)
- packages/teams-bot/src/intent/alias-resolver.ts   (purpose name updates)
- packages/teams-bot/src/bot.ts                     (drop filter; meta calls meta_compose)
- packages/teams-bot/src/mcp/tool-discovery.ts      (cache key includes employeeId)
- packages/shared/src/clients/prompts/bot-intent-classify.ts  (3-label prompt)
- packages/shared/src/clients/prompts/index.ts                (register meta-compose)
- packages/hr-service/src/modules/**/mcp-tools/*.ts  (~30 tools — description + requiredPermission annotation)

Hard rules (Seven Non-Negotiables):
- tenantId: string (not optional) on every domain interface — unchanged
- No hand-curated tool registries. Routing decisions derive from MCP
  tool metadata at runtime
- Every server.tool() carries requiredPermission annotation (use null
  explicitly when unrestricted)
- No @anthropic-ai/sdk imports
- Stubs forbidden — every function ships with a working body
- Re-seed Langfuse as part of deploy (bot.intent_classify and the new
  bot.meta_compose); the seed script is idempotent on no-change

Tool description shape (mandatory): scope + audience + output +
sibling-disambiguation. Phrasing examples are tiebreakers, not the
primary lever. See SLICE_43 doc for the role_list reference example.

Acceptance: see "Verification" in SLICE_43_REMOVE_CATEGORY_LAYER.md
(canonical query smoke tests + cost regression check).

If a finding requires changing earlier slice output: log a cross-slice
note per slices/CROSS_SLICE_NOTES.md and continue. Do not refactor
outside this slice.

Commit: slice(43): remove hardcoded category layer; full-catalog function calling
```

---

## PROMPT Slice 44 — Tool catalog embeddings (vector retrieval pre-filter)

```
You are working on the CIP Platform TypeScript monorepo.

Session: Slice 44 — Tool catalog embeddings (vector retrieval pre-filter)
Package: @cip/hr-service, @cip/teams-bot, @cip/shared
Verify: pnpm --filter @cip/hr-service typecheck
        pnpm --filter @cip/teams-bot typecheck
        pnpm --filter @cip/shared typecheck

Prerequisite: Slice 43 complete. Tool descriptions follow the
scope/audience/output shape; requiredPermission annotations on every
tool; intent pipeline is chitchat|meta|proceed with single `route` alias.

Read before writing:
- CLAUDE.md
- slices/SLICE_44_TOOL_EMBEDDINGS.md           (this slice's full spec)
- slices/CROSS_SLICE_NOTES.md
- packages/hr-service/src/db/migrations/003_ai_memory.sql  (pgvector pattern reference — agent_memory_vectors)
- packages/hr-service/src/services/permission-catalog-seed.ts  (idempotent seed pattern reference)
- packages/hr-service/src/main.ts             (add seed call)
- packages/teams-bot/src/mcp/tool-discovery.ts (insert retrieval step)
- packages/teams-bot/src/bot.ts                (pass message into discoverTools)
- packages/shared/src/clients/litellm.ts       (add embedding helper if missing)

Goal: add a tool_embeddings table (pgvector, HNSW cosine), an idempotent
indexer that runs on hr-service startup (re-embeds only on
description_hash change — zero API calls on no-op restart), and a
top-K retrieval step in discoverTools (between permission filter and
router LLM). Embedding via cip-embed alias → mistral-embed.

Files to create:
- packages/hr-service/src/db/migrations/015_tool_embeddings.sql
- packages/hr-service/src/services/tool-embeddings-seed.ts
- packages/teams-bot/src/intent/embed-cache.ts  (LRU 256/60s)

Files to modify:
- packages/hr-service/src/main.ts                  (call seedToolEmbeddings after seedPermissionCatalog)
- packages/teams-bot/src/mcp/tool-discovery.ts     (retrieval step + cache stores permission-filtered list, not retrieval result)
- packages/teams-bot/src/bot.ts                    (pass user message text into discoverTools)
- packages/shared/src/clients/litellm.ts           (embedding helper if missing)

Hard rules (Seven Non-Negotiables):
- tool_embeddings is the ONLY table that's not tenant-scoped — tools
  are defined by service code, not data. Document this in the migration.
- description_hash MUST be deterministic: sha256(name + ' ' + description
  + ' ' + JSON.stringify(paramSchema)). Stable across pod restarts.
- Indexer MUST be idempotent. Re-runs without description changes do
  zero embedding API calls (verify via the [tool-embeddings] log line).
- Indexer MUST clean up orphans (tools removed from code) in the same
  transaction as the upsert pass — partial registry never wipes embeddings.
- Multi-replica safe: ON CONFLICT (service, tool_name) DO UPDATE
  WHERE EXCLUDED.description_hash <> tool_embeddings.description_hash
- discoverTools MUST handle empty tool_embeddings (first deploy before
  the indexer runs) — fall back to full permission-filtered list silently
- discoverTools MUST handle empty intersection (no permitted tool ranks
  in top K) — fall back to full permission-filtered list silently
- No @anthropic-ai/sdk imports
- Stubs forbidden — every function ships with a working body

Acceptance: see "Verification" in SLICE_44_TOOL_EMBEDDINGS.md
(indexer smoke test + retrieval correctness query table + cost/latency
regression check).

If a finding requires changing earlier slice output: log a cross-slice
note per slices/CROSS_SLICE_NOTES.md and continue. Do not refactor
outside this slice.

Commit: slice(44): tool embeddings + vector retrieval pre-filter
```

---

## PROMPT CROSS-SLICE

```
You are working on the CIP Platform TypeScript monorepo.

Session: CROSS-SLICE — Resolve outstanding cross-slice notes

Read before writing:
- slices/CROSS_SLICE_NOTES.md
- Each file listed under "File:" in every OPEN note

For each OPEN note:
1. Apply the exact fix described in the note
2. Run typecheck on the affected package: pnpm --filter @cip/<package> typecheck
3. Mark the note RESOLVED with today's date and a one-line "Fix applied:" summary

Do not fix DEFERRED notes. Do not touch files not listed in an open note.
