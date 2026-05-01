# Slice 43 — Remove the hardcoded category layer

> **Prerequisite:** Slices 39B (intent classifier) and 41 (Langfuse-hosted prompts) deployed. The current bot is on `b240cb8` (post-crash-fix).
> **Package:** `@cip/teams-bot`, `@cip/shared`, `@cip/hr-service` (DB migration + tool description sweep)
> **Verify:** `pnpm --filter @cip/teams-bot typecheck && pnpm --filter @cip/shared typecheck`, then bot smoke test against the canonical query set (see Verification).

---

## Why This Slice Exists

The bot's intent pipeline today is a 2-stage LLM hop with a hand-curated category map sandwiched in between:

```
user message
    ↓
[Stage 1] LLM picks one of: chitchat | meta | cert_query | cert_action | hr_admin | reasoning
    ↓
[hardcoded TOOLS_FOR_CATEGORY map] filters the tool catalog
    ↓
[Stage 2] LLM picks one tool from the filtered subset
```

Every recurring intent-routing bug we've debugged traces back to that middle layer:

- Slice 42A/42C added eight admin tools. Nobody added them to `TOOLS_FOR_CATEGORY['hr_admin']`. "What are my roles" classified as `hr_admin`, the filtered subset was empty of role tools, the model picked something irrelevant or nothing.
- The classifier hallucinates labels outside the enum (`capabilities`, `employee_info`, `greeting`). Schema coercion patches the symptom; the root cause is asking a small model to map intent to an arbitrary list of strings instead of to a tool.
- Inline-only categories (`chitchat`, `meta`) crash Stage 2 if the model forgets `inline_reply`. Patched defensively in `b240cb8`; the dual-state (category gates routing AND inline-vs-tool dispatch) is the underlying problem.

The original justification (slice 39B) was performance: small classifier model + small Stage-2 catalog kept tokens and latency down at ~5 tools. We're now at ~30 tools across four modules. **The category layer is no longer earning its keep — it's a hand-maintained registry that drifts and causes the bugs we keep patching.**

---

## What 43 DOES

- **Collapses the intent enum from six labels to three:** `chitchat`, `meta`, `proceed`. Only the first two short-circuit (no tool runs); `proceed` always goes to function calling with the full permitted catalog.
- **Deletes** `TOOLS_FOR_CATEGORY`, `CATEGORY_DESCRIPTIONS`, `PURPOSE_FOR_CATEGORY`, `CATEGORY_USER_HELP`, `filterToolsByCategory`. The category-→-tool-subset map is the bug source; it goes.
- **Single router alias** (`route`) replaces the three category-specific aliases (`route_simple`, `route_careful`, `route_reasoning`). The DB migration collapses the three rows in `routing_rules`.
- **Restores LLM-composed meta** as a dedicated second LLM call (alias: `meta_compose`) that takes the user's permitted tool list and renders a short menu. Drops the deterministic `buildMetaResponse` static map introduced post-`e7e066d`.
- **Tool description sweep** across every `server.tool()` registration in `@cip/hr-service`. After this sweep each tool description follows: scope + audience + output + sibling-disambiguation. Phrasing examples are illustrative, not the primary disambiguation lever.
- **Permission annotations audit:** every tool gets a `requiredPermission` annotation read by `discoverTools`. Today the annotation is partial — some tools rely only on the in-handler `assertPermission` call. With the LLM seeing a wider catalog, every gap becomes "tool the LLM picks that 401s on invoke." Close all of them.
- **Fixes the `discoverTools` cache key bug:** today the key is `tenantId`; same-tenant users with different permissions can share a cache entry. Change to `${tenantId}:${employeeId}` (or a hash of the permission set) so each user sees their own filtered list.

## What 43 does NOT do

- Doesn't change the classifier model. Stays `open-mistral-nemo` via `cip-classifier` alias.
- Doesn't introduce vector retrieval. At ~30 tools, function-calling-over-the-full-catalog is correct. Once we hit ~80–100 tools the right move is embedding the catalog and retrieving top-N relevant tools per query — out of scope here.
- Doesn't change the permission model. Roles → groups → permissions → tools is unchanged. Annotations just surface the existing gates to discovery.

---

## Model Choices

Mistral-only, kept as policy. Three aliases, all resolved through LiteLLM via the existing `routing_rules` table.

| Alias             | Model                  | Purpose                                                   | Why this size                                         |
|-------------------|------------------------|-----------------------------------------------------------|-------------------------------------------------------|
| `intent_classify` | `open-mistral-nemo`    | 3-label classify (chitchat / meta / proceed) + optional inline_reply for chitchat | Trivial decision; nemo is fast (~400ms) and cheap (~$0.0001/call). |
| `meta_compose`    | `open-mistral-nemo`    | Compose the meta reply ("here's what I can help with") from the user's permitted tool list | Text composition with tool-list context, no function calling. Same model as classifier; one less alias to operate. |
| `route`           | `mistral-small-latest` | Function calling with ~30 tools to pick the right action  | nemo is unreliable for function calling at this catalog size — wrong-sibling picks and occasional malformed `tool_calls` JSON. small (~22B) handles 30 tools cleanly with ~$0.001/turn cost and ~700ms latency. |

**Escape hatch:** if `mistral-small-latest` shows consistent wrong-sibling picks after the description sweep, swap that one row in `routing_rules` to `mistral-large-latest`. Per-tenant override possible via the same mechanism. No code change.

**Why not `ministral-3b` / `ministral-8b`:** edge-focused; function-calling reliability with 30 tools is poor.

**Why not Anthropic models (Haiku/Sonnet):** team policy is Mistral-only. Revisit only if `mistral-large-latest` proves insufficient.

---

## Tool description rules

After this slice, every `server.tool()` description in `@cip/hr-service` MUST follow this shape. Lead with **scope/audience/output**; treat phrasing examples as illustrative tiebreakers only.

```ts
server.tool(
  'role_list',
  'Returns every CIP role defined in the caller\'s tenant. ' +
  'Scope: tenant-wide (all roles, not just the caller\'s). ' +
  'Audience: HR admins (gated on employee.list permission). ' +
  'Output: array of {code, label, group_count}. ' +
  'Differs from get_employee_permissions (caller\'s own roles only) ' +
  'and employee_get (one specific employee\'s assigned roles).',
  { /* zod schema */ },
  { requiredPermission: 'employee.list' },  // <- Slice 43: every tool gets this
  handler,
);
```

**Why this works without categories:** the LLM sees every permitted tool every turn and does semantic similarity across the *whole* catalog. Scope/audience/output are invariant to surface phrasing — the user can ask "show me the role types" or "what kinds of roles do we have" and the model still routes to the tenant-scoped tool because that's the only one whose scope matches.

**Why example queries are not the primary lever:** they're a maintenance treadmill (every new phrasing variant might need adding). Use them only when scope alone can't differentiate from siblings (rare).

---

## Files in scope

```
packages/teams-bot/src/intent/tool-categories.ts            (heavy delete)
packages/teams-bot/src/intent/classifier.ts                 (3-label schema)
packages/teams-bot/src/intent/router.ts                     (no category, single alias)
packages/teams-bot/src/intent/debug-banner.ts               (rename `category` → `intent`)
packages/teams-bot/src/intent/alias-resolver.ts             (purpose name updates)
packages/teams-bot/src/intent/meta-compose.ts               NEW — meta_compose call
packages/teams-bot/src/bot.ts                               (drop filter call; meta calls meta_compose)
packages/teams-bot/src/mcp/tool-discovery.ts                (cache key fix)
packages/shared/src/clients/prompts/bot-intent-classify.ts  (3-label prompt)
packages/shared/src/clients/prompts/bot-meta-compose.ts     NEW — meta-compose fallback
packages/shared/src/clients/prompts/index.ts                (register new prompt)
packages/hr-service/src/db/migrations/014_routing_rules_collapse.sql  NEW
packages/hr-service/src/modules/**/mcp-tools/*.ts           (description + permission annotation sweep — ~30 files)
slices/SLICE_43_REMOVE_CATEGORY_LAYER.md                    (this file)
slices/PROMPTS_DEPLOY.md                                    (record the meta-compose seed step)
slices/CONTEXT_WORKFLOW.md                                  (record slice 43 in the slice map)
```

---

## Migration: `routing_rules` collapse

```sql
-- 014_routing_rules_collapse.sql
-- Slice 43: collapse per-category router rows into a single `route` purpose.
-- Drops route_simple/route_careful/route_reasoning; inserts route + meta_compose.
-- Idempotent (ON CONFLICT DO UPDATE for inserts; DELETE WHERE for the drop).

DELETE FROM routing_rules
 WHERE purpose IN ('route_simple', 'route_careful', 'route_reasoning');

INSERT INTO routing_rules (tenant_id, purpose, model)
VALUES
  ('00000000-0000-0000-0000-000000000000', 'route',        'mistral-small-latest'),
  ('00000000-0000-0000-0000-000000000000', 'meta_compose', 'open-mistral-nemo')
ON CONFLICT (tenant_id, purpose) DO UPDATE SET model = EXCLUDED.model;

-- intent_classify is unchanged (already seeded).
```

---

## Hard Rules (Non-Negotiables)

- `tenantId: string` (not optional) on every domain interface — unchanged.
- **No new hand-curated tool registries.** If a registry is needed, it's derived from MCP tool metadata at runtime.
- **Every `server.tool()` registration carries a `requiredPermission` annotation.** Tools without permission requirements use an explicit `null` annotation, not omission.
- All stubs use `throw new Error('not implemented')`.
- The Langfuse seed script must run as part of bootstrap — `bot.intent_classify` and the new `bot.meta_compose` need their `production` versions live before the new bot image is deployed.

---

## Verification

**Typecheck:**
```
pnpm --filter @cip/teams-bot typecheck
pnpm --filter @cip/shared typecheck
pnpm --filter @cip/hr-service typecheck
```

**Smoke tests** (run against deployed bot, both as an HR admin and as a baseline employee — the permitted tool sets differ):

| Query                              | Expected route                          |
|------------------------------------|------------------------------------------|
| "Hi"                               | `chitchat` → LLM inline_reply            |
| "What can I do"                    | `meta` → `meta_compose` LLM call         |
| "What tools can I use"             | `meta` → `meta_compose` LLM call         |
| "What are my roles"                | `proceed` → `get_employee_permissions`   |
| "List employees"                   | `proceed` → `employee_list` (HR only)    |
| "Show my certifications"           | `proceed` → `get_my_certifications`     |
| "Who has the cert.submit permission" | `proceed` → `permission_holders` (HR only) |
| "List roles"                       | `proceed` → `role_list` (HR only)       |

No `routeIntent called for category=…` errors in pod logs. No tool returns 401 from the LLM picking something the user can't actually invoke.

**Cost regression check:** capture LiteLLM `usage` for ten canonical queries pre- and post-deploy. The router now sees ~30 tools instead of ~5–10; expect ~1.5–2× input tokens on `route` calls. Acceptable; well under cents/turn at small-latest pricing.

---

## Cross-Slice Notes

None expected. This slice is contained to the bot's intent pipeline + the hr-service tool description sweep. Schema and routing_rules changes are additive/replacing-stale-rows; no other service depends on the retired purpose names.
