# Slice 46e — Admin MCP tools for `bot_turn_metrics` + clickable turn footer

> **Prerequisite:** Slice 48 deployed (`bot_turn_metrics` table populated). Recommended: `slices/BOT_PERF_DEBUGGING.md` runbook reviewed first — this slice productizes some of those queries.
> **Package:** `@cip/hr-service` (5 new MCP tools), `@cip/teams-bot` (slash command + adaptive-card footer).
> **Verify:** From inside Teams as an admin: `/turn 592edfbe` returns a card with that turn's full metrics + a Langfuse deep link. Tapping the inline turn footer triggers the same flow without typing.

---

## Why

Slice 48 wired `bot_turn_metrics` and the Langfuse trace tree. They're reachable from a laptop with `psql` and a browser. **They're not reachable from Teams.** Two costs:

1. **Operator friction.** When a user complains about a slow turn, the admin needs to: open laptop → port-forward → `psql` → query → copy turnId → open Langfuse in a browser. Not catastrophic, but enough friction that quick triage gets skipped on mobile.
2. **The turn footer is a dead end.** `⏱ 9.23s … turn=592edfbe` ends in a turnId that's only useful if you copy it elsewhere. The admin already has Teams open. A click should drill in.

This slice adds the missing inside-Teams path:
- 5 new MCP tools that wrap the most common SQL queries from the runbook
- A slash command `/turn <id>` for typed access
- An adaptive-card footer with a tappable "🔍 Inspect" action that fires `/turn <id>` automatically

## What this slice IS

### Five MCP tools (all `requiredPermission: 'bot.metrics.read'`)

1. **`bot_metrics_get_turn(turn_id)`** — single-turn detail. Returns the full row + a Langfuse trace URL constructed from `LANGFUSE_HOST` + `turn_id`. This is the click target.

2. **`bot_metrics_summary(since: '1h'|'24h'|'7d'|'30d')`** — high-level overview. Returns: turn count, p50/p95/p99 of `total_ms` and `graph_ms`, intent mix (`{ ask: N, direct: N, tool: N, unknown: N }`), refusal rate, confirmation rate, resume rate. One concise card.

3. **`bot_metrics_top_n(metric: 'total_ms'|'graph_ms'|'step_count', since, limit, intent?)`** — top-N turns. Default: latency. Filterable by intent. Each row carries a `turn_id` link the admin can drill into.

4. **`bot_metrics_tools(since)`** — per-tool breakdown. For each tool name in `tools_attempted`: call count, avg `graph_ms`, p95 `graph_ms`, refusal count, refusal rate. Sorted by call count.

5. **`bot_metrics_outliers(since)`** — flagged turns in one query. Surfaces:
   - Refusals (any in `tools_refused`)
   - High step count (≥ 3)
   - Low triage confidence (< 0.5)
   - Latency above the period's p95
   - Confirmation fired but never resumed (abandoned writes)
   Each entry tagged with the reason code.

### Slash command `/turn <id>`

Wraps `bot_metrics_get_turn` plus rendering. Parses the trailing token; if it's not a recognizable turn_id (8-hex), shows usage. On hit, renders an adaptive card with:
- Compact summary of the row
- Latency breakdown
- Tools attempted (and any refused)
- Triage signals (confidence, clarification, confirmation flags)
- "Open in Langfuse" external link button (deep-links to the trace)
- "🔁 Show summary for this thread" button → calls `bot_metrics_summary` scoped to thread

### Clickable turn footer

[debug-banner.ts](../packages/teams-bot/src/intent/debug-banner.ts) currently sends a plain-text footer like:
```
⏱ 9.23s (route=8.33s) · langgraph:tool · cip-classifier → cip-router-careful → employee_get · turn=592edfbe
```

After this slice, the same content renders as a small adaptive card with a tappable inline action:
```
[ ⏱ 9.23s (route=8.33s) · langgraph:tool · cip-classifier → cip-router-careful → employee_get · turn=592edfbe   🔍 ]
```

Tapping the magnifier fires a `messageBack` with `text: "/turn 592edfbe"`. Teams renders the click as if the user typed it; the bot's slash dispatcher invokes the new flow.

### Optional: `/metrics` slash command

A small wrapper that calls `bot_metrics_summary` over the last 24h. One-keystroke health check.

## What this slice is NOT

- **Not a write surface.** All five tools are read-only. No DELETE, no UPDATE.
- **Not cross-tenant.** Each tool scopes by `tenant_id = ctx.tenantId`. A platform-admin tool for cross-tenant aggregation is a separate slice if needed.
- **Not real-time / streaming.** Queries hit Postgres on each call. With Slice 46d's retention in place, the table stays bounded.
- **Not a Grafana replacement.** Grafana is still the right surface for time-series dashboards. This slice covers ad-hoc / interactive triage.
- **Not a Langfuse replacement.** Langfuse remains the only place to see *why* a turn was slow (per-LLM-call info). This slice tells you *which* turn.

---

## Permissions

New permission `bot.metrics.read`, seeded into `permission_catalog`. Granted by default to the existing `hr-service-admin` role (which the `PLATFORM_ADMIN_EMAIL` bootstraps into). Adding it to other groups/roles is a per-tenant operator decision.

```sql
-- migration NNN_bot_metrics_permission.sql
INSERT INTO permission_catalog (key, module, description) VALUES
  ('bot.metrics.read', 'platform',
   'Read access to bot_turn_metrics — required for /turn, /metrics, and the bot_metrics_* admin MCP tools.')
ON CONFLICT (key) DO NOTHING;

-- Add to hr-service-admin role's permissions
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, 'bot.metrics.read'
  FROM roles r WHERE r.code = 'hr-service-admin'
ON CONFLICT (role_id, permission_key) DO NOTHING;
```

---

## Tool annotations — must transit via `/admin/tool-metadata`

All five tools register `whenToUse` / `whenNotToUse` / `outputSchema` / `requiredPermission`. The MCP SDK strips these on the wire (commit `11c67ce` documents this). The bot picks them up via the `/admin/tool-metadata` side channel automatically — no per-tool plumbing needed beyond standard registration.

Example annotation block (`bot_metrics_get_turn`):
```ts
{
  requiredPermission: 'bot.metrics.read',
  sideEffectLevel: 'read',
  whenToUse: [
    'User asks about a specific turn — pasted a turn_id, or clicked the inline turn-debug footer',
    'Admin debugging a user complaint about a slow / wrong / weird turn',
  ],
  whenNotToUse: [
    'User wants aggregate stats — use bot_metrics_summary instead',
    'User wants top-N slow turns — use bot_metrics_top_n instead',
    'turn_id is not 8-hex — refuse with usage hint',
  ],
  commonNextTools: ['bot_metrics_summary'],
  outputSchema: { /* see implementation */ },
}
```

---

## Files in scope

```
packages/hr-service/src/db/migrations/NNN_bot_metrics_permission.sql        NEW
packages/hr-service/src/modules/admin/mcp-tools/bot-metrics.get-turn.tool.ts NEW
packages/hr-service/src/modules/admin/mcp-tools/bot-metrics.summary.tool.ts  NEW
packages/hr-service/src/modules/admin/mcp-tools/bot-metrics.top-n.tool.ts    NEW
packages/hr-service/src/modules/admin/mcp-tools/bot-metrics.tools.tool.ts    NEW
packages/hr-service/src/modules/admin/mcp-tools/bot-metrics.outliers.tool.ts NEW
packages/hr-service/src/modules/admin/mcp-tools/index.ts                     (register 5 tools)
packages/hr-service/src/db/queries/bot-turn-metrics.ts                       NEW (shared query helpers)

packages/teams-bot/src/slash-commands/handlers/turn.ts                       NEW (/turn <id>)
packages/teams-bot/src/slash-commands/handlers/metrics.ts                    NEW (/metrics — optional)
packages/teams-bot/src/slash-commands/registry.ts                            (register slash commands)
packages/teams-bot/src/intent/debug-banner.ts                                (adaptive-card footer with messageBack)

packages/hr-service/src/cards/turn-detail.card.ts                            NEW (rendered by /turn)

slices/SLICE_46E_ADMIN_METRICS_TOOLS.md                                       this file
```

---

## Hard rules

- **Read-only.** All five tools. No mutation.
- **Tenant-scoped.** Every query has `WHERE tenant_id = $1` set from `authInfo.token`.
- **Permission-gated.** Every tool checks `bot.metrics.read` server-side via existing `assertPermission` (plus the bot's UX filter via `requiredPermission` annotation).
- **No magic numbers.** Time windows accepted only as `'1h' | '6h' | '24h' | '7d' | '30d'`; the parser is a tiny enum, not arbitrary text.
- **Bounded result size.** `top_n` capped at 50; `outliers` capped at 25. Larger queries belong in `psql`.
- **Langfuse URL constructor uses `LANGFUSE_HOST`.** Don't hardcode `cloud.langfuse.com`.
- **`/turn` parser is strict.** Argument must match `/^[0-9a-f]{8}$/`. Anything else → usage hint.
- **No turn fails because of metrics tools.** All queries best-effort. Wrap in try/catch. Errors surface as a refusal envelope, not a 500.

---

## Verification

**`bot_metrics_get_turn` happy path:**
1. Pick a recent turn from the bot. Note its `turn=<id>`.
2. As an admin, send `/turn <id>` in Teams.
3. Card renders with: timestamp, intent, latency, tools, "Open in Langfuse" link.
4. Click the link → opens the Langfuse trace in a browser.

**`bot_metrics_summary` happy path:**
1. `/metrics` (or LLM-mediated "show me bot metrics for the last 24 hours").
2. Card shows turn count, p50/p95, intent mix, refusal/confirmation/resume rates.

**`bot_metrics_top_n`:** "show me the slowest 10 turns from the last hour."

**`bot_metrics_tools`:** "which tools are used most this week?"

**`bot_metrics_outliers`:** "any unusual turns today?"

**Click-through (clickable footer):**
1. Send any message to the bot. Receive reply with the new card-style footer.
2. Tap "🔍" on the footer.
3. Verify Teams sends `/turn <id>` and the bot returns the detail card.
4. Repeat on mobile to confirm tappability.

**Permission denial:**
1. As a non-admin user, type `/turn <id>`. Bot refuses politely ("requires `bot.metrics.read`").

**Tenant isolation:**
1. Tenant A's admin queries `/turn <id>` for a turn belonging to tenant B. Bot returns "not found" — never leaks cross-tenant data.

---

## Out of scope (deferred)

- Cross-tenant aggregate dashboard (platform-admin only).
- Time-series chart rendering inside Teams (adaptive cards aren't built for this; Grafana is the right tool).
- Push alerts on outlier turns (would need a separate alerting pipeline).
- Editing or deleting metrics rows — never.

---

## Cross-slice notes

- The `/admin/tool-metadata` side channel (commit `11c67ce`) means new MCP tools' annotations transit automatically. No per-tool plumbing.
- **bot.plan prompt update**: the new tools' `whenToUse` strings should hint enough for the planner to route correctly without explicit prompt-engineering. Watch the first day after deploy for refusals or wrong-tool picks.
- **46d's retention** keeps these queries fast as the table grows. Without it, `bot_metrics_summary` over 30d slows down within a few months.
- **Slice 49 (bot memory)** could plumb a `pref.preferred_metrics_window` to default `/metrics` to a per-user time range without args. Not in scope here.
