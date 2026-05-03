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

## PROMPT Slice 53 — Card-driven write-action confirm + invoke router

```
You are working on the CIP Platform TypeScript monorepo.

Session: Slice 53 — Card-driven write-action confirm + invoke router
Package: @cip/teams-bot, @cip/hr-service (one tunables migration)
Verify: pnpm --filter @cip/teams-bot typecheck && pnpm --filter @cip/hr-service typecheck && pnpm -r run typecheck

Prerequisite: Slice 46 (PostgresSaver) and Slice 46b (interrupt()-based
confirm) must be live. This slice changes the *rendering* of the
suspended-confirm state from text to an Adaptive Card; the suspension
mechanism itself is unchanged. Slice 47 (slash registry) is helpful but
not required — invoke routing is independent.

Read before writing:
- CLAUDE.md
- slices/SLICE_53_CARD_CONFIRM.md           (this slice's full spec)
- slices/SLICE_46B_NATIVE_INTERRUPT.md      (interrupt() mechanism)
- slices/SLICE_46_DURABLE_LANGGRAPH_STATE.md  § "State persistence"
- slices/CROSS_SLICE_NOTES.md
- slices/BOT_ARCHITECTURE.md                § "Auth + tenancy", "Conversation lifecycle"

Goal: Replace the Slice 46b text confirmation ("About to: X. Reply
yes/no.") with an Adaptive Card v1.5 carrying Action.Execute
[Confirm] [Cancel] buttons. Lay the verb-dispatched invoke router that
future card flows (cert-submit Dialog in Slice 54, employee-detail
action panel) will register against — only the confirmWriteAction verb
registers in this slice. Per-tenant kill switch back to text via
lg.confirm_render_mode = 'text' preserves Slice 46b behaviour byte-for-byte.

Files to create:
- packages/teams-bot/src/teams-protocol/cards/confirm.ts
    (buildConfirmCard + buildResultCard; pure functions, no I/O)
- packages/teams-bot/src/teams-protocol/invoke-router.ts
    (registerInvokeHandler + dispatchInvoke; verb-dispatched, returns null on miss)
- packages/teams-bot/src/teams-protocol/invoke-handlers/confirm-write.ts
    (verb=confirmWriteAction; validates click + resumes graph with Command({resume}))
- packages/hr-service/src/db/migrations/<NNN>_lg_confirm_render_mode.sql
    (seed three tunable keys — see SLICE_53 doc)

Files to modify:
- packages/teams-bot/src/langgraph/nodes/confirm.ts
    (interrupt payload gains turnId + proposedAt; accept structured
     {decision} from card click in addition to string from text reply)
- packages/teams-bot/src/langgraph/util/classify-confirm-reply.ts
    (accept string | { decision: 'confirm' | 'cancel' } union)
- packages/teams-bot/src/langgraph/runner.ts
    (read lg.confirm_render_mode; on suspension, send card OR text)
- packages/teams-bot/src/bot.ts
    (route adaptiveCard/action through dispatchInvoke before super.onInvokeActivity)
- packages/teams-bot/src/index.ts
    (registerInvokeHandler at boot for confirmWriteAction)

Hard rules (Seven Non-Negotiables + slice-specific):
- No tenantId in card data — flows from authInfo.token (Non-Negotiable 6)
- No magic numbers — three new tunables seeded; all reads via getTunable<T>()
- Stubs forbidden — handler ships fully implemented (Non-Negotiable 7)
- No @anthropic-ai/sdk imports anywhere
- Idempotency on duplicate click: re-check graph suspension state, return
  "Already handled" card with statusCode 200 if already advanced
- Verified user identity: activity.from.aadObjectId on the click MUST
  match the original turn's caller (read from suspended checkpoint state).
  Reject mismatches with refusal card
- TTL'd cards: proposedAt checked against lg.confirm_card_ttl_seconds
- Action.Execute only (Universal Action) — no Action.Submit on new cards
- Authorization re-check on click (defense in depth) — server-side
  assertPermission in the tool handler still fires regardless
- Card rendering is pure: buildConfirmCard / buildResultCard take payload
  in, return IAdaptiveCard JSON out, no I/O

State-shape rule: NO new field on StateAnnotation. The interrupt()
payload grows two scalars (turnId, proposedAt) but those are payload,
not state-graph schema. state.proposedWriteCall (Slice 46b) is unchanged.

Acceptance: see "Verification" in SLICE_53_CARD_CONFIRM.md (eight paths:
card confirm, card cancel, pod-restart resilience, TTL rejection,
wrong-user click rejection, duplicate-click idempotency, text-mode
fallback, mixed-mode interleave, re-plan).

If a finding requires changing earlier slice output: log a cross-slice
note per slices/CROSS_SLICE_NOTES.md and continue. Do not refactor
outside this slice. In particular: do NOT migrate the Slice 46e /turn
footer card from messageBack to Action.Execute (out of scope).

Commit: slice(53): card-driven write-action confirm + invoke router
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
