# Slice 39B — LLM-as-Classifier in the Bot

> **Prerequisite:** Slice 39A (per-purpose routing foundation) complete.
> **Package:** `@cip/teams-bot`
> **Verify:** `pnpm --filter @cip/teams-bot typecheck && pnpm -r run typecheck`

---

## Why This Slice Exists

Today, the bot's intent flow does two things in one expensive LLM call:

```ts
// packages/teams-bot/src/intent/router.ts
client.chat.completions.create({
  model: 'cip-chat',                  // Sonnet (or Mistral Small post-39A)
  messages: [{ role: 'user', content: message }],
  tools: tools.map(t => ({...})),     // ALL 25 tools in catalog
  tool_choice: 'auto',
})
```

Three problems:

1. **"hi" hits the same path as "create employee X for tenant Y."** Trivial messages get the full tool catalog and the most expensive model. Observed `route=` latency: 1.7s–6.5s.
2. **Tool selection accuracy degrades with catalog size.** A 25-tool prompt is harder for any model than a 3-tool prompt, even though most user intents only need a handful of tools.
3. **No early-exit for chitchat.** A user typing "thanks" still pays for tool selection then gets a "no tool match" reply. Pure waste.

Slice 39B introduces a two-stage flow:

- **Stage 1 — classifier.** Tiny `cip-classifier` (Mistral Nemo) call, ~300–600ms, emits `{ category, complexity, inline_reply? }`. For chitchat/meta categories it ALSO emits the user-facing reply — Stage 2 is skipped.
- **Stage 2 — tool selection.** Existing `routeIntent`, but with: (a) a tool catalog filtered to the category-relevant subset, (b) a model picked per-category via `resolveAlias()` from Slice 39A.

The classifier output drives both branches. No new MCP tools, no schema changes — pure bot-side refactor.

---

## What You Are Building

```
packages/teams-bot/src/
  intent/
    classifier.ts           ← NEW: Stage 1 — Mistral Nemo, returns { category, complexity, inline_reply? }
    tool-categories.ts      ← NEW: per-tool category mapping + filter helper
    router.ts               ← MOD: Stage 2 only; takes filtered tools + alias from caller
    debug-banner.ts         ← NEW: dev-only debug message builder
  bot.ts                    ← MOD: call classifier first, branch on inline_reply, otherwise call router

packages/teams-bot/helm/
  values.yaml               ← MOD: BOT_DEBUG_CLASSIFICATION env (off by default)
```

---

## Read Before Writing

- `packages/teams-bot/src/intent/router.ts` (current single-call flow)
- `packages/teams-bot/src/intent/alias-resolver.ts` (Slice 39A — `resolveAlias()`)
- `packages/teams-bot/src/bot.ts` `handleAuthenticatedMessage` (call site)
- `packages/teams-bot/src/mcp/tool-discovery.ts` (where `tools[]` comes from — already permission-filtered)
- `packages/shared/src/clients/litellm.ts` `callLLM()` (Slice 39A — purpose-tagged wrapper)

Do **not** modify `tool-discovery.ts` — its permission filter still runs first; the category filter is layered on top.

---

## Hard Rules (Seven Non-Negotiables)

1. **Classifier returns `Category`, never an alias.** Hard separation: bot code maps category → alias via `resolveAlias()`. The classifier prompt must never mention `cip-router-fast` or any other LiteLLM alias.
2. **`inline_reply` short-circuits Stage 2 entirely.** If the classifier sets `inline_reply`, the bot renders it and returns. No further LLM calls in that turn.
3. **Stage 2 receives a *filtered* tool list.** The category determines the subset; never pass all 25 tools to Stage 2.
4. **Categories are a closed Zod enum.** Defined in `tool-categories.ts`. Adding a category requires editing the enum, the prompt, and the filter map together — type checker enforces consistency.
5. **`tenantId` flows through both stages.** Stage 1 and Stage 2 both call `resolveAlias()` with the tenant — per-tenant routing overrides apply equally.
6. **Permission filter still runs first.** `discoverTools()` returns the user's permitted tools; `tool-categories.ts` further filters that. A user without `cert.submit` permission never sees `process_document` regardless of classifier output.
7. **Fallback path exists.** If the classifier returns malformed JSON (rare but possible with `open-mistral-nemo`), fall through to the *legacy* single-stage routing using the user's full permitted tool set. Log it for follow-up. The slice does not remove the legacy code path.

---

## The flow after this slice

```
[user message]
  │
  ▼
handleAuthenticatedMessage:
  - resolveAuthContext (existing — sync_employee + get_employee_permissions)
  - tools = await discoverTools(ctx)         ← permission-filtered already
  │
  ▼
classifier.ts:
  Stage 1 LLM call to cip-classifier (Mistral Nemo)
  Prompt: "Classify this user message into one of: chitchat, meta,
           cert_query, cert_action, hr_admin, reasoning. If chitchat
           or meta, also emit a friendly inline_reply. Return JSON
           matching this schema."
  Returns: { category: 'cert_query', complexity: 'simple' }
        OR { category: 'chitchat', complexity: 'simple', inline_reply: 'Hi!' }
  │
  ├── inline_reply set?
  │     YES → render inline_reply, log [turn] mode=inline, return
  │     NO  → continue to Stage 2
  │
  ▼
router.ts (Stage 2):
  - alias = await resolveAlias({ purpose: aliasForCategory[category], tenantId })
  - filteredTools = filterToolsByCategory(tools, category)
  - callLLM(client, {
      model: alias,
      tools: filteredTools.map(t => ...),
      messages: [{ role: 'user', content: message }],
      purpose: 'bot.route_<category>',
      tenantId,
    })
  - If a tool was picked, return { name, args } and execute as before
  │
  ▼
[response rendered]
```

---

## `intent/tool-categories.ts` (NEW)

Defines the closed enum and the tool-category map.

```typescript
import type { Tool as McpTool } from '@modelcontextprotocol/sdk/types.js';

export const CATEGORIES = [
  'chitchat',     // "hi", "thanks" — inline reply, no tools
  'meta',         // "what can you do?" — inline reply derived from permissions
  'cert_query',   // "show my certs", "when does X expire"
  'cert_action',  // "upload this cert"
  'hr_admin',     // "create employee X", "disable Y"
  'reasoning',    // multi-step / fall-through
] as const;

export type Category = (typeof CATEGORIES)[number];

/**
 * Slice 39B: which Slice 39A `purpose` to resolve for each category's
 * Stage-2 LLM call. Categories with null skip Stage 2 entirely (handled
 * by the classifier's inline_reply path).
 */
export const PURPOSE_FOR_CATEGORY: Record<Category, string | null> = {
  chitchat:    null,                 // inline_reply only
  meta:        null,                 // inline_reply only
  cert_query:  'route_simple',
  cert_action: 'route_simple',
  hr_admin:    'route_careful',
  reasoning:   'route_reasoning',
};

/**
 * Slice 39B: per-category tool catalog filter. Names are MCP tool names
 * (matching server.tool('<name>') registrations in hr-service).
 *
 * `null` = no Stage 2 (chitchat/meta).
 * Empty array would mean "no tools, just LLM-only response" — not used today.
 */
const TOOLS_FOR_CATEGORY: Record<Category, string[] | null> = {
  chitchat: null,
  meta:     null,

  cert_query: [
    'get_my_certifications',
    'get_submission_status',
    'get_expiring_certifications',
    'get_staff_certifications',
    'get_compliance_summary',
  ],

  cert_action: [
    'process_document',
    'resolve_hitl',
  ],

  hr_admin: [
    'employee_create',
    'employee_list',
    'employee_find',
    'employee_assign_role',
    'employee_revoke_role',
    'employee_migrate_identity',
    'employee_disable',
    'employee_grant_permission',
    'employee_revoke_permission',
    'list_staff',
  ],

  // 'reasoning' gets the full catalog — multi-step intents may span domains.
  reasoning: null, // null here means "use all permitted tools, not a subset"
};

export function filterToolsByCategory(
  tools: McpTool[],
  category: Category,
): McpTool[] {
  const allowed = TOOLS_FOR_CATEGORY[category];
  if (allowed === null) return tools; // 'reasoning' or chitchat/meta (Stage 2 skipped)
  return tools.filter(t => allowed.includes(t.name));
}
```

The mapping is a literal because (a) it's small enough to read at a glance, (b) changing it should require a code review, (c) there's no per-tenant variation needed for tool→category — that's a tool author's choice, not a tenant's.

---

## `intent/classifier.ts` (NEW)

```typescript
import { z } from 'zod';
import { createLiteLLMClient, callLLM } from '@cip/shared';
import { resolveAlias } from './alias-resolver.js';
import { CATEGORIES, type Category } from './tool-categories.js';
import type { BotAuthContext } from '../auth/resolve-context.js';

const ClassificationSchema = z.object({
  category:     z.enum(CATEGORIES),
  complexity:   z.enum(['simple', 'reasoning']),
  inline_reply: z.string().optional(),
});

export type Classification = z.infer<typeof ClassificationSchema>;

const SYSTEM_PROMPT = `
You are a fast intent classifier for a workplace HR/compliance bot.
Classify the user's message into exactly one category:

- "chitchat"    : greetings, thanks, social pleasantries. Emit a brief
                  friendly inline_reply (1 sentence).
- "meta"        : questions about the bot itself ("what can you do?",
                  "help"). Emit a one-paragraph inline_reply describing
                  the bot's capabilities at a high level.
- "cert_query"  : the user wants to read certification or compliance data.
- "cert_action" : the user wants to upload/submit/approve a certificate.
- "hr_admin"    : the user wants to manage employees, roles, or permissions.
- "reasoning"   : multi-step intents that span categories, or anything
                  unclear. Use sparingly — only when no single category fits.

Set complexity:
- "simple"   : one tool call should answer this.
- "reasoning": likely needs multiple tools or planning.

Return ONLY a JSON object matching this schema. No prose, no markdown.

{
  "category": "<one of the above>",
  "complexity": "<simple|reasoning>",
  "inline_reply": "<only set for chitchat/meta>"
}
`.trim();

export async function classify(
  message: string,
  ctx: BotAuthContext,
): Promise<Classification | null> {
  const alias = await resolveAlias({
    purpose:  'intent_classify',
    tenantId: ctx.tenantId,
  });
  const client = createLiteLLMClient({
    tenantId:   ctx.tenantId,
    virtualKey: ctx.tenantConfig.litellmVirtualKey,
  });

  const resp = await callLLM(client, {
    model: alias,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user',   content: message },
    ],
    response_format: { type: 'json_object' },
    temperature: 0,
    purpose:  'bot.intent_classify',
    tenantId: ctx.tenantId,
  });

  const text = resp.choices[0]?.message.content ?? '';
  try {
    return ClassificationSchema.parse(JSON.parse(text));
  } catch (err) {
    console.warn(`[classifier] malformed output, falling back: ${err instanceof Error ? err.message : String(err)} — raw="${text.slice(0, 200)}"`);
    return null; // signal fallback to legacy single-stage routing
  }
}
```

`response_format: { type: 'json_object' }` is OpenAI-compatible JSON mode. LiteLLM forwards it; Mistral honours it.

---

## `intent/router.ts` (MOD — Stage 2 only)

Replace the existing `routeIntent` with a Stage-2-only version that takes a pre-resolved alias and a pre-filtered tool list:

```typescript
import type { Tool as McpTool } from '@modelcontextprotocol/sdk/types.js';
import { createLiteLLMClient, callLLM } from '@cip/shared';
import { resolveAlias } from './alias-resolver.js';
import { PURPOSE_FOR_CATEGORY, type Category } from './tool-categories.js';
import type { BotAuthContext } from '../auth/resolve-context.js';

export interface RouteResult {
  selected: { name: string; args: Record<string, unknown> } | null;
  alias:    string;   // exposed so bot.ts can include in the debug banner
}

export async function routeIntent(args: {
  message:  string;
  category: Category;
  tools:    McpTool[];   // already filtered by category + permissions
  ctx:      BotAuthContext;
}): Promise<RouteResult> {
  const purpose = PURPOSE_FOR_CATEGORY[args.category];
  if (!purpose) {
    // Caller bug — category should have been handled by inline_reply.
    throw new Error(`routeIntent called for category=${args.category} which has no Stage-2 purpose`);
  }
  const alias = await resolveAlias({ purpose, tenantId: args.ctx.tenantId });
  const client = createLiteLLMClient({
    tenantId:   args.ctx.tenantId,
    virtualKey: args.ctx.tenantConfig.litellmVirtualKey,
  });

  const resp = await callLLM(client, {
    model: alias,
    messages: [{ role: 'user', content: args.message }],
    tools: args.tools.map(t => ({
      type: 'function' as const,
      function: {
        name: t.name,
        ...(t.description ? { description: t.description } : {}),
        parameters: t.inputSchema as Record<string, unknown>,
      },
    })),
    tool_choice: 'auto',
    purpose:  `bot.${purpose}`,
    tenantId: args.ctx.tenantId,
  });

  const call = resp.choices[0]?.message.tool_calls?.[0];
  const selected = call ? {
    name: call.function.name,
    args: JSON.parse(call.function.arguments) as Record<string, unknown>,
  } : null;
  return { selected, alias };
}
```

Two signature changes from before:
- `routeIntent(args: {...})` (object form) instead of positional.
- Returns `RouteResult` (`{ selected, alias }`) instead of just the selected tool — `alias` is needed for the debug banner.

---

## `bot.ts` (MOD — call classifier first)

Modify `handleAuthenticatedMessage` to insert the classifier between auth and routing. Existing timing instrumentation (added earlier this session) extends naturally — add `classify=` and switch the `mode=` tags.

The relevant block (around the existing `discover/route/exec` path):

```typescript
import { classify } from './intent/classifier.js';
import { filterToolsByCategory } from './intent/tool-categories.js';
import { routeIntent } from './intent/router.js';

// ... inside handleAuthenticatedMessage, after tools = await discoverTools(ctx):

const tDiscover = Date.now();

const classification = await classify(text, ctx);
const tClassify = Date.now();

if (classification?.inline_reply) {
  await context.sendActivity(classification.inline_reply);
  await maybeSendDebugBanner(context, { classification, alias: null, tool: null, timings: { classify: tClassify - tDiscover, total: Date.now() - tStart } });
  console.log(`[turn] tenantId=${ctx.tenantId} mode=inline category=${classification.category} typing=${tTyping - tStart}ms auth=${tAuth - tTyping}ms registry=${tRegistry - tAuth}ms discover=${tDiscover - tRegistry}ms classify=${tClassify - tDiscover}ms total=${Date.now() - tStart}ms`);
  return;
}

// Fallback: classifier failed. Use legacy full-catalog routing as safety net.
const category = classification?.category ?? 'reasoning';
const filteredTools = filterToolsByCategory(tools, category);

const routeResult = await routeIntent({ message: text, category, tools: filteredTools, ctx });
const tRoute = Date.now();
const selected = routeResult?.selected ?? null;
const stage2Alias = routeResult?.alias ?? null;

if (selected) {
  const result = await executeTool(selected.name, selected.args, ctx);
  const tExec = Date.now();
  await renderResponse(context, result);
  await maybeSendDebugBanner(context, {
    classification, alias: stage2Alias, tool: selected.name,
    timings: { classify: tClassify - tDiscover, route: tRoute - tClassify, exec: tExec - tRoute, total: Date.now() - tStart },
  });
  console.log(`[turn] tenantId=${ctx.tenantId} mode=tool category=${category} fallback=${classification ? 'no' : 'yes'} typing=${tTyping - tStart}ms auth=${tAuth - tTyping}ms registry=${tRegistry - tAuth}ms discover=${tDiscover - tRegistry}ms classify=${tClassify - tDiscover}ms route=${tRoute - tClassify}ms exec=${tExec - tRoute}ms render=${Date.now() - tExec}ms total=${Date.now() - tStart}ms tool=${selected.name}`);
} else {
  await context.sendActivity(buildNoToolMessage(filteredTools));
  await maybeSendDebugBanner(context, {
    classification, alias: stage2Alias, tool: null,
    timings: { classify: tClassify - tDiscover, route: tRoute - tClassify, total: Date.now() - tStart },
  });
  console.log(`[turn] tenantId=${ctx.tenantId} mode=no-tool category=${category} fallback=${classification ? 'no' : 'yes'} typing=${tTyping - tStart}ms auth=${tAuth - tTyping}ms registry=${tRegistry - tAuth}ms discover=${tDiscover - tRegistry}ms classify=${tClassify - tDiscover}ms route=${tRoute - tClassify}ms reply=${Date.now() - tRoute}ms total=${Date.now() - tStart}ms`);
}
```

Three new turn modes:
- `mode=inline` — classifier returned `inline_reply`. No Stage 2.
- `mode=tool` — Stage 2 picked a tool. Now also includes `category=` and `fallback=`.
- `mode=no-tool` — Stage 2 ran but picked nothing. Same.

Note: `routeIntent` now returns `{ selected, alias }` instead of just `selected` — the caller needs the resolved alias for the debug banner. Update the function signature accordingly.

---

## `intent/debug-banner.ts` (NEW) — dev-only classifier visibility

A pluggable debug banner that posts an extra message after every bot reply showing what the classifier decided, which alias served the call, and the per-stage timing. Off by default; enabled per-pod via the `BOT_DEBUG_CLASSIFICATION` env var.

```typescript
import type { TurnContext } from '@microsoft/agents-hosting';
import type { Classification } from './classifier.js';

interface DebugInput {
  classification: Classification | null;   // null when classifier failed
  alias:          string | null;           // Stage 2 alias used; null if inline or no-tool
  tool:           string | null;           // tool selected; null if inline or no-tool
  timings:        {
    classify: number;
    route?:   number;
    exec?:    number;
    total:    number;
  };
}

function debugEnabled(): boolean {
  return (process.env['BOT_DEBUG_CLASSIFICATION'] ?? '').toLowerCase() === 'true';
}

export async function maybeSendDebugBanner(
  context: TurnContext,
  input:   DebugInput,
): Promise<void> {
  if (!debugEnabled()) return;

  const { classification, alias, tool, timings } = input;
  const lines: string[] = ['🔍 **classifier debug**'];

  if (classification === null) {
    lines.push('• category: _classifier failed — fell back to legacy single-stage routing_');
  } else {
    lines.push(`• category: \`${classification.category}\` (complexity: \`${classification.complexity}\`)`);
    if (classification.inline_reply) {
      lines.push('• inline_reply: yes — Stage 2 skipped');
    }
  }

  if (alias) lines.push(`• stage 2 alias: \`${alias}\``);
  if (tool)  lines.push(`• tool: \`${tool}\``);

  const t = `classify=${timings.classify}ms` +
            (timings.route !== undefined ? ` route=${timings.route}ms` : '') +
            (timings.exec  !== undefined ? ` exec=${timings.exec}ms`   : '') +
            ` total=${timings.total}ms`;
  lines.push(`• timings: ${t}`);

  await context.sendActivity(lines.join('\n'));
}
```

The banner sends as a **separate Teams activity** following the main reply, so it never contaminates the actual response. Markdown formatting renders nicely in Teams (bullets + inline code).

### Toggling at runtime

The env var lives on the bot pod, so you flip it without rebuilding:

```bash
# Turn on for the running pod (until restart):
kubectl set env -n cip-app deploy/teams-bot BOT_DEBUG_CLASSIFICATION=true

# Turn off:
kubectl set env -n cip-app deploy/teams-bot BOT_DEBUG_CLASSIFICATION-

# Or via helm if you want it persistent in dev-cluster:
# (edit packages/teams-bot/helm/values.yaml and helm upgrade)
```

`kubectl set env` triggers a rollout immediately. Within ~30s the new pod is up and every subsequent message posts a debug banner alongside the main reply. Good for live demos and debugging routing surprises.

### Why this doesn't ship to production

It's not a security risk — the banner only contains routing metadata, no user data, no tokens. But it's cluttery for real users, and the inline_reply latency feels worse if a debug message appears after every "hi". So default is `false`. Production tenants never see it unless explicitly enabled.

If you ever want to turn it on for a *specific* user (e.g. an admin), the natural extension is a permission check (`if (debugEnabled() || ctx.permissions['bot.debug'])`). That's a small follow-up — keep it env-only for now.

### Helm values

```yaml
# packages/teams-bot/helm/values.yaml — add to env block:
env:
  ...
  # Slice 39B: when 'true', bot posts a markdown debug banner after every
  # reply showing classifier output, Stage 2 alias, and per-stage timing.
  # Off by default. Toggle live with:
  #   kubectl set env -n cip-app deploy/teams-bot BOT_DEBUG_CLASSIFICATION=true
  BOT_DEBUG_CLASSIFICATION: "false"
```

---

## Acceptance Criteria

- [ ] User messages "hi", "thanks", "ok" trigger `mode=inline category=chitchat`. No Stage-2 LLM call. Latency under 1 second end-to-end.
- [ ] User messages "what can you do?", "help" trigger `mode=inline category=meta`. Inline reply describes the bot's capabilities.
- [ ] User message "show my certs" triggers `mode=tool category=cert_query`. Stage 2 sees only the 5 cert_query tools. `route=` LLM call uses `cip-router-fast` (resolved via Slice 39A's `routing_rules`).
- [ ] User message "create employee jdoe@…" triggers `mode=tool category=hr_admin`. Stage 2 sees only the 10 hr_admin tools. Resolved via `cip-router-careful`.
- [ ] Classifier malformed-output path works: temporarily forcing `null` from `classify()` causes `mode=tool category=reasoning fallback=yes` with the full permitted catalog as Stage 2 input. No errors surfaced to user.
- [ ] Permission filter still applies: a user without `cert.submit` who says "upload this" sees Stage 2 with zero tools (process_document filtered out by permissions before category filter ran).
- [ ] Langfuse cloud shows separate traces tagged `purpose=bot.intent_classify` (Stage 1) and `purpose=bot.route_<category>` (Stage 2) for the same turn. Filterable, groupable.
- [ ] Tenant override works: `UPDATE tenant_settings SET routing_overrides = '{"bot.route_simple":"cip-router-careful"}'::jsonb WHERE tenant_id='…'` causes that tenant's `cert_query`/`cert_action` to use `cip-router-careful` after the 5-min cache TTL (or pod restart).
- [ ] `BOT_DEBUG_CLASSIFICATION=true` causes a markdown banner to appear in Teams after every reply, showing category, complexity, Stage 2 alias (if any), tool selected (if any), and per-stage timing. `BOT_DEBUG_CLASSIFICATION=false` (or unset) shows nothing extra. Live-toggleable via `kubectl set env`.
- [ ] `pnpm --filter @cip/teams-bot typecheck` passes.
- [ ] `pnpm -r run typecheck` passes.

---

## Out of Scope

- Streaming Stage 2 responses (would need bot/Teams-protocol changes).
- Conversation memory across turns (each turn classifies independently).
- Tool chaining ("call A, then B") — Stage 2 still picks one tool. Multi-step is `category=reasoning` and the LLM produces a single tool call; subsequent steps are subsequent user turns.
- Per-tenant category customisation (e.g. "this tenant's `hr_admin` should also include cert_action tools"). Categories are global.
- A/B testing classifier prompt variants — that's a `routing_rules` swap (point `intent_classify` at a different alias backed by a different prompt-tuned model).
- Removing the legacy single-stage `routeIntent` path that this slice's fallback uses. Keep it as a safety net for one or two slices, then deprecate when classifier reliability is proven (>99.5% well-formed JSON).

---

## Cross-Slice Notes

If Slice 39A hasn't run, this slice cannot land — `resolveAlias()`, `callLLM()`, `routing_rules`, and `cip-classifier` alias all come from 39A. Hard prerequisite.

If `cip-classifier` is not yet wired to `MISTRAL_API_KEY` in `litellm-credentials`, the classifier call will 500 from LiteLLM. The fallback path catches this — every turn becomes `category=reasoning fallback=yes`, full catalog routed through `cip-reasoning`. Worse latency than today, but functionally working. Confirm `MISTRAL_API_KEY` is set before deploy.

---

## Commit

```
slice(39B): LLM-as-classifier in the bot

Two-stage intent flow:
  Stage 1: cip-classifier (Mistral Nemo) → { category, complexity, inline_reply? }
  Stage 2: cip-router-{fast|careful|reasoning} via Slice 39A's resolveAlias

chitchat / meta short-circuit with inline_reply, no Stage-2 call.
Other categories filter the tool catalog to the relevant subset and
pick a model per-category — HR admin uses cip-router-careful, simple
intents use cip-router-fast, multi-step uses cip-reasoning.

Classifier failure falls back to legacy single-stage routing with the
full permitted catalog. Logged for follow-up; never fails the turn.

Per-tenant routing_overrides from 39A apply to both stages.
```
