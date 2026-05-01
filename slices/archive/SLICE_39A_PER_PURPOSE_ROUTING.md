# Slice 39A — Per-Purpose LLM Routing Foundation

> **Prerequisite:** Slice 38 (permissions + bot routing baseline) complete.
> **Package:** `@cip/teams-bot`, `@cip/hr-service`, `@cip/shared`
> **Verify:** `pnpm --filter @cip/teams-bot typecheck && pnpm --filter @cip/hr-service typecheck && pnpm --filter @cip/shared typecheck && pnpm -r run typecheck`

---

## Why This Slice Exists

Today, every LLM call site picks a model by hardcoded alias:

```ts
// packages/teams-bot/src/intent/router.ts:16
client.chat.completions.create({ model: 'cip-chat', ... })

// packages/hr-service/src/modules/certifications/agents/vision-agent/nodes.ts:58
{ model: 'cip-vision' }
```

Tuning requires a code change → CI build → redeploy. There's no per-tenant override path. Langfuse can show "model X used N times" but not "model X was used N times for *bot intent routing*" — the call's purpose is invisible.

Slice 39A introduces a small foundation that splits routing into two layers:

1. **`(service, purpose) → alias`** — a DB table, tunable via SQL. New rows take effect within 5 minutes (cache TTL), no deploy.
2. **`alias → provider model`** — stays in LiteLLM (YAML for declared baseline + DB for runtime additions when `store_model_in_db: true`).

It also adds **per-purpose tagging** to every LLM call so Langfuse can answer "what did this purpose cost this month?"

**Slice 39A introduces no user-facing behaviour change.** The bot still uses `cip-chat` end-to-end, hr-service still uses `cip-vision`/`cip-lightweight`. Today's flow is preserved exactly — but every call now passes through `resolveAlias()` and tags itself in Langfuse. Slice 39B builds the LLM-as-classifier flow on top of this foundation.

---

## What You Are Building

```
packages/hr-service/src/
  db/
    migrations/
      009_routing_rules.sql                      ← NEW: routing_rules table + seed
    queries/
      routing-rules.ts                           ← NEW: list + lookup helpers
  services/
    alias-resolver.ts                            ← NEW: in-process resolver (DB)
  routes/
    admin-routing.ts                             ← NEW: GET /admin/routing-rules?service=X
  index.ts                                       ← MOD: mount admin-routing route
  modules/certifications/
    agents/vision-agent/nodes.ts                 ← MOD: pass purpose, resolve alias
    activities/match-employee.activity.ts        ← MOD: pass purpose, resolve alias
    activities/match-cert-definition.activity.ts ← MOD: pass purpose, resolve alias

packages/teams-bot/src/
  intent/
    alias-resolver.ts                            ← NEW: HTTP-backed resolver, 5min cache
    router.ts                                    ← MOD: resolve alias for 'route_simple'

packages/shared/src/
  clients/
    litellm.ts                                   ← MOD: accept purpose, inject Langfuse metadata

infra/helm/litellm/
  values.yaml                                    ← MOD: store_model_in_db:true,
                                                       new aliases, model_info blocks
```

---

## Read Before Writing

- `packages/hr-service/src/db/queries/employees.ts` (style: PoolClient + sql)
- `packages/hr-service/src/db/migrations/008_role_permissions.sql` (style: ALTER + seed)
- `packages/hr-service/src/routes/admin-tenants.ts` (PLATFORM_ADMIN_TOKEN auth pattern)
- `packages/hr-service/src/db/index.ts` (Pool/Db setup)
- `packages/teams-bot/src/auth/tenant-resolver.ts` (HTTP fetch + cache pattern; 5-min TTL)
- `packages/shared/src/clients/litellm.ts` (current shape)
- `infra/helm/litellm/values.yaml` (current model_list)

Do **not** read or modify any classifier / category code — that's all Slice 39B.

---

## Hard Rules (Seven Non-Negotiables)

1. **`purpose` is a required argument** on the shared LiteLLM client wrapper. TypeScript-enforced. No optional, no default. A call site without a purpose is a build error.
2. **`(service, purpose)` is a closed pair.** Both halves are namespaced strings — `service` ∈ `{'bot', 'hr-service', 'platform-core'}`, `purpose` is service-defined. The keys are documented in this slice; adding new pairs in code without adding the matching `routing_rules` row is forbidden (the resolver falls back to `FALLBACK_ALIAS = 'cip-chat'` and logs a warning, but production should never hit that path).
3. **`tenantId` flows through every resolver call.** Per-tenant overrides in `tenant_settings.routing_overrides` are read first, global defaults second. No request-scoped tenant inference.
4. **Aliases stay in LiteLLM, never duplicated.** The `routing_rules` table stores alias *names* (TEXT), not provider model names. LiteLLM is the only system that knows what each alias resolves to.
5. **Resolver caches with 5-minute TTL.** Same TTL as `tool-discovery.ts` and `tenant-resolver.ts` — match the existing pattern. SQL UPDATE → ≤5 min to live.
6. **No behaviour change visible to users.** Acceptance criteria below explicitly preserve today's routing for every existing call site. The slice is foundation only.
7. **Stubs forbidden.** Every function ships with a working body. The `FALLBACK_ALIAS` is a real return value, not a `throw new Error('not implemented')`.

---

## The two-layer flow after this slice

```
[call site]
  client.chat.completions.create({
    model: await resolveAlias({ service:'bot', purpose:'route_simple', tenantId }),
    metadata: { purpose: 'bot.route_simple', tenantId, userId },
    messages: [...],
  })
   │
   ▼
[resolveAlias()]
  1. Read tenant_settings.routing_overrides (cached 5min)
  2. If overrides[`bot.route_simple`] set → return that alias
  3. Otherwise read routing_rules where service='bot' AND purpose='route_simple'
  4. Otherwise return FALLBACK_ALIAS = 'cip-chat'
   │
   ▼
[LiteLLM proxy]
  Looks up alias in YAML model_list (or runtime DB entries)
  Forwards to provider with `metadata.purpose` propagated to Langfuse callback
   │
   ▼
[Provider call]
   │
   ▼
[Langfuse]
  Trace tagged with: model_alias, model_name, tenantId, purpose
  Filter/group by any of those in cloud.langfuse.com
```

---

## Migration: `009_routing_rules.sql` (NEW)

Use the next free 00X number: 009.

```sql
-- Slice 39A: store the (service, purpose) → alias mapping.
-- Aliases live in LiteLLM; this table picks WHICH alias each call site uses.
-- Tunable via SQL UPDATE; bot/hr-service cache 5 min.
--
-- service:  'bot' | 'hr-service' | 'platform-core' — closed enum, code-defined.
-- purpose:  service-defined snake_case identifier for the call site.
-- alias:    LiteLLM alias name (must exist in LiteLLM model_list or runtime DB).

CREATE TABLE IF NOT EXISTS routing_rules (
  service     TEXT        NOT NULL,
  purpose     TEXT        NOT NULL,
  alias       TEXT        NOT NULL,
  notes       TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by  TEXT,
  PRIMARY KEY (service, purpose)
);

-- Per-tenant routing override JSONB. Key shape: '<service>.<purpose>' = '<alias>'.
-- Resolved BEFORE the global routing_rules row when both are set.
ALTER TABLE tenant_settings
  ADD COLUMN IF NOT EXISTS routing_overrides JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Seed: every CURRENT call site preserved + new purposes registered (dormant
-- until consumers wire them up — call sites for the dormant purposes land in
-- Slice 39B and a future vision-agent refactor slice).
INSERT INTO routing_rules (service, purpose, alias, notes) VALUES
  -- bot: today's single-stage routing (used by router.ts as 'route_simple')
  ('bot',        'route_simple',        'cip-chat',           'Default tool-selection LLM call. Slice 39B will add route_careful + route_reasoning as alternates.'),

  -- bot: dormant — Slice 39B wires these
  ('bot',        'intent_classify',     'cip-classifier',     'Stage-1 intent classifier (Slice 39B).'),
  ('bot',        'route_careful',       'cip-router-careful', 'Stage-2 tool selection for HR admin (Slice 39B).'),
  ('bot',        'route_reasoning',     'cip-reasoning',      'Stage-2 tool selection for multi-step reasoning (Slice 39B).'),

  -- hr-service: existing call sites preserved
  ('hr-service', 'vision_extract',      'cip-vision',         'Vision agent OCR/extraction (existing).'),
  ('hr-service', 'employee_match',      'cip-lightweight',    'Match employee row by fuzzy name (existing).'),
  ('hr-service', 'cert_def_match',      'cip-lightweight',    'Match cert-definition by fuzzy name (existing).'),

  -- hr-service: dormant — registered for future vision-agent refactor.
  -- The "_small" variants are intentional cost knobs; callers pick based on input size.
  ('hr-service', 'ocr_document',        'cip-ocr-document',       'Full document OCR — quality-critical compliance docs.'),
  ('hr-service', 'ocr_document_small',  'cip-ocr-document-small', 'Draft / preview document OCR — cheap path.'),
  ('hr-service', 'ocr_image',           'cip-ocr-image',          'Photo of physical certificate — OCR + reasoning.'),
  ('hr-service', 'ocr_image_small',     'cip-ocr-image-small',    'Thumbnail / quick triage image OCR.'),
  ('hr-service', 'document_understand', 'cip-document',           'Text-only document reasoning, no OCR.')

ON CONFLICT (service, purpose) DO UPDATE
  SET alias      = EXCLUDED.alias,
      notes      = EXCLUDED.notes,
      updated_at = NOW(),
      updated_by = 'migration-009';
```

If the seed conflicts with an operator's manual edits, ON CONFLICT DO UPDATE will overwrite — re-running the migration is a hard reset to baseline. Document this in the commit message.

---

## `db/queries/routing-rules.ts` (NEW)

```typescript
import type { PoolClient } from 'pg';

export interface RoutingRule {
  service: string;
  purpose: string;
  alias:   string;
  notes:   string | null;
}

/**
 * Slice 39A: list every routing rule for a given service. Used by the
 * /admin/routing-rules?service=X endpoint AND by hr-service's own
 * in-process resolver to build a per-service map.
 */
export async function listRoutingRulesByService(
  client: PoolClient,
  service: string,
): Promise<RoutingRule[]> {
  const r = await client.query<RoutingRule>(
    `SELECT service, purpose, alias, notes
       FROM routing_rules
      WHERE service = $1
      ORDER BY purpose`,
    [service],
  );
  return r.rows;
}

/**
 * Slice 39A: lookup a single rule. Returns null if no row matches —
 * caller is expected to fall back to FALLBACK_ALIAS.
 */
export async function getRoutingRule(
  client: PoolClient,
  service: string,
  purpose: string,
): Promise<RoutingRule | null> {
  const r = await client.query<RoutingRule>(
    `SELECT service, purpose, alias, notes
       FROM routing_rules
      WHERE service = $1 AND purpose = $2`,
    [service, purpose],
  );
  return r.rows[0] ?? null;
}

/**
 * Slice 39A: read tenant_settings.routing_overrides for a tenant.
 * Returns the JSONB blob as a Record<string, string>; '<service>.<purpose>' → alias.
 */
export async function getTenantRoutingOverrides(
  client: PoolClient,
  tenantId: string,
): Promise<Record<string, string>> {
  const r = await client.query<{ overrides: Record<string, string> }>(
    `SELECT COALESCE(routing_overrides, '{}'::jsonb) AS overrides
       FROM tenant_settings WHERE tenant_id = $1`,
    [tenantId],
  );
  return r.rows[0]?.overrides ?? {};
}
```

All three queries take `PoolClient` — caller manages RLS via the existing `set_config('app.current_tenant_id', $1, true)` pattern. `routing_rules` is **not** RLS-scoped (global table); `tenant_settings` is.

---

## `services/alias-resolver.ts` (NEW, hr-service)

In-process resolver for hr-service's own LLM calls. Uses Pool directly — no HTTP hop.

```typescript
import { getPool } from '../db/index.js';
import {
  listRoutingRulesByService,
  getTenantRoutingOverrides,
  type RoutingRule,
} from '../db/queries/routing-rules.js';

const FALLBACK_ALIAS = 'cip-chat';
const TTL_MS = 5 * 60 * 1000;

interface CacheEntry { rules: Map<string, string>; expiresAt: number; }
interface OverrideEntry { overrides: Record<string, string>; expiresAt: number; }

const rulesCache: Map<string, CacheEntry> = new Map();        // key: service
const overridesCache: Map<string, OverrideEntry> = new Map(); // key: tenantId

async function loadServiceRules(service: string): Promise<Map<string, string>> {
  const cached = rulesCache.get(service);
  if (cached && Date.now() < cached.expiresAt) return cached.rules;

  const pool = getPool();
  const client = await pool.connect();
  try {
    const rows: RoutingRule[] = await listRoutingRulesByService(client, service);
    const rules = new Map(rows.map(r => [r.purpose, r.alias]));
    rulesCache.set(service, { rules, expiresAt: Date.now() + TTL_MS });
    return rules;
  } finally {
    client.release();
  }
}

async function loadTenantOverrides(tenantId: string): Promise<Record<string, string>> {
  const cached = overridesCache.get(tenantId);
  if (cached && Date.now() < cached.expiresAt) return cached.overrides;

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantId]);
    const overrides = await getTenantRoutingOverrides(client, tenantId);
    await client.query('COMMIT');
    overridesCache.set(tenantId, { overrides, expiresAt: Date.now() + TTL_MS });
    return overrides;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Slice 39A: resolve a `(service, purpose)` to a LiteLLM alias for a given tenant.
 * Order: tenant override → global routing_rule → FALLBACK_ALIAS.
 */
export async function resolveAlias(args: {
  service:  string;
  purpose:  string;
  tenantId: string;
}): Promise<string> {
  const overrides = await loadTenantOverrides(args.tenantId);
  const overrideKey = `${args.service}.${args.purpose}`;
  if (overrides[overrideKey]) return overrides[overrideKey]!;

  const rules = await loadServiceRules(args.service);
  const alias = rules.get(args.purpose);
  if (alias) return alias;

  console.warn(`[alias-resolver] no rule for ${overrideKey} — falling back to ${FALLBACK_ALIAS}`);
  return FALLBACK_ALIAS;
}

// Test-only helper to clear caches between cases.
export function _resetAliasResolverCaches(): void {
  rulesCache.clear();
  overridesCache.clear();
}
```

---

## `routes/admin-routing.ts` (NEW, hr-service)

Bot reads routing rules via this endpoint. Auth: `PLATFORM_ADMIN_TOKEN` Bearer (existing pattern from `admin-tenants.ts`).

```typescript
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPool } from '../db/index.js';
import {
  listRoutingRulesByService,
  getTenantRoutingOverrides,
} from '../db/queries/routing-rules.js';
import { requirePlatformAdminToken } from './admin-tenants.js'; // existing middleware

const QuerySchema = z.object({
  service:  z.enum(['bot', 'hr-service', 'platform-core']),
  tenantId: z.string().uuid().optional(),
});

export async function registerAdminRouting(app: FastifyInstance): Promise<void> {
  app.get('/admin/routing-rules', { preHandler: requirePlatformAdminToken }, async (req, reply) => {
    const parsed = QuerySchema.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });

    const { service, tenantId } = parsed.data;
    const pool = getPool();
    const client = await pool.connect();
    try {
      const rules = await listRoutingRulesByService(client, service);
      let overrides: Record<string, string> = {};
      if (tenantId) {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantId]);
        overrides = await getTenantRoutingOverrides(client, tenantId);
        await client.query('COMMIT');
      }
      return reply.send({ rules, overrides });
    } finally {
      client.release();
    }
  });
}
```

Mount in `packages/hr-service/src/index.ts` next to the existing `admin-tenants` registration.

---

## `intent/alias-resolver.ts` (NEW, teams-bot)

HTTP-backed resolver for the bot. Calls hr-service `/admin/routing-rules`.

```typescript
const FALLBACK_ALIAS = 'cip-chat';
const TTL_MS = 5 * 60 * 1000;

interface RuleSet {
  rules: Record<string, string>;     // purpose → alias
  overrides: Record<string, string>; // 'service.purpose' → alias
  expiresAt: number;
}

const cache = new Map<string, RuleSet>(); // key: tenantId

async function loadRules(tenantId: string): Promise<RuleSet> {
  const cached = cache.get(tenantId);
  if (cached && Date.now() < cached.expiresAt) return cached;

  const baseUrl = process.env['HR_SERVICE_URL'];
  const token = process.env['PLATFORM_ADMIN_TOKEN'];
  if (!baseUrl || !token) {
    console.warn('[alias-resolver] HR_SERVICE_URL or PLATFORM_ADMIN_TOKEN missing — falling back');
    return { rules: {}, overrides: {}, expiresAt: Date.now() + TTL_MS };
  }
  const url = new URL(`${baseUrl}/admin/routing-rules`);
  url.searchParams.set('service', 'bot');
  url.searchParams.set('tenantId', tenantId);

  const resp = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) {
    console.warn(`[alias-resolver] fetch failed: HTTP ${resp.status} — falling back`);
    return { rules: {}, overrides: {}, expiresAt: Date.now() + TTL_MS };
  }
  const body = (await resp.json()) as {
    rules:     Array<{ purpose: string; alias: string }>;
    overrides: Record<string, string>;
  };
  const rules = Object.fromEntries(body.rules.map(r => [r.purpose, r.alias]));
  const entry: RuleSet = {
    rules,
    overrides: body.overrides,
    expiresAt: Date.now() + TTL_MS,
  };
  cache.set(tenantId, entry);
  return entry;
}

export async function resolveAlias(args: {
  purpose:  string;
  tenantId: string;
}): Promise<string> {
  const ruleset = await loadRules(args.tenantId);
  const overrideKey = `bot.${args.purpose}`;
  if (ruleset.overrides[overrideKey]) return ruleset.overrides[overrideKey]!;
  if (ruleset.rules[args.purpose]) return ruleset.rules[args.purpose]!;
  console.warn(`[alias-resolver] no rule for ${overrideKey} — falling back to ${FALLBACK_ALIAS}`);
  return FALLBACK_ALIAS;
}
```

The bot is `service='bot'` always — hardcoded in the URL build. Not parameterised: the bot only ever asks about its own routing.

---

## `clients/litellm.ts` (MOD, shared)

Add `purpose` to client options; auto-inject as Langfuse metadata on every call.

Current shape:

```typescript
export interface LiteLLMClientOptions {
  tenantId: string;
  virtualKey: string;
  baseURL?: string;
}
export function createLiteLLMClient(opts: LiteLLMClientOptions): OpenAI {
  return new OpenAI({
    apiKey: opts.virtualKey,
    baseURL: opts.baseURL ?? process.env['LITELLM_BASE_URL'],
    defaultHeaders: { 'x-tenant-id': opts.tenantId },
  });
}
```

New shape: keep the client, but add a thin wrapper that callers use instead of `client.chat.completions.create` directly. Forces `purpose` to be passed.

```typescript
import OpenAI from 'openai';
import type { ChatCompletion, ChatCompletionCreateParamsNonStreaming } from 'openai/resources/chat/completions';

export interface LiteLLMClientOptions {
  tenantId:   string;
  virtualKey: string;
  baseURL?:   string;
}

export function createLiteLLMClient(opts: LiteLLMClientOptions): OpenAI {
  return new OpenAI({
    apiKey:  opts.virtualKey,
    baseURL: opts.baseURL ?? process.env['LITELLM_BASE_URL'],
    defaultHeaders: { 'x-tenant-id': opts.tenantId },
  });
}

/**
 * Slice 39A: per-purpose-tagged completion call. Every LLM call site uses
 * this, never `client.chat.completions.create` directly.
 *
 * `purpose` is dot-namespaced — '<service>.<purpose>' (e.g. 'bot.route_simple',
 * 'hr-service.ocr_document'). Surfaces in Langfuse as a filterable tag.
 */
export async function callLLM(
  client: OpenAI,
  args: ChatCompletionCreateParamsNonStreaming & {
    purpose:    string;
    tenantId:   string;
    extraMeta?: Record<string, string | number | boolean>;
  },
): Promise<ChatCompletion> {
  const { purpose, tenantId, extraMeta, ...rest } = args;
  return client.chat.completions.create({
    ...rest,
    metadata: {
      purpose,
      tenantId,
      ...(extraMeta ?? {}),
    } as Record<string, string>,
  });
}
```

`extraMeta` is escape hatch for callers wanting to add their own tags (turnId, userId, etc.). Langfuse stores all metadata fields as filterable tags.

---

## Updating existing call sites

Every caller of `client.chat.completions.create` switches to `callLLM(client, { ..., purpose })`. The five existing sites:

| File | Existing `model` | New `purpose` |
|---|---|---|
| `packages/teams-bot/src/intent/router.ts:16` | `'cip-chat'` | `'bot.route_simple'` |
| `packages/hr-service/.../vision-agent/nodes.ts:58` | `'cip-vision'` | `'hr-service.vision_extract'` |
| `packages/hr-service/.../match-employee.activity.ts:107` | `'cip-lightweight'` | `'hr-service.employee_match'` |
| `packages/hr-service/.../match-cert-definition.activity.ts:92` | `'cip-lightweight'` | `'hr-service.cert_def_match'` |

Each call site:
1. Imports `resolveAlias` (the bot import differs from the hr-service import — see Out of Scope)
2. Calls `resolveAlias({ service, purpose, tenantId })` to get the model name
3. Calls `callLLM(client, { model: resolvedAlias, purpose, tenantId, ... })`

The `purpose` string is dot-namespaced (`'<service>.<purpose>'`) when passed to `callLLM`, but un-namespaced (`'route_simple'`, `'vision_extract'`) when passed to `resolveAlias` because the resolver knows its own service. Keep these consistent — the hard rule is that `purpose` in the LLM `metadata` field always carries the full `<service>.<purpose>` form for Langfuse.

---

## LiteLLM config: `infra/helm/litellm/values.yaml` (MOD)

Three changes:

1. Enable `store_model_in_db: true` in `litellm_settings` so runtime `/model/new` calls persist.
2. Add the new aliases for the dormant purposes (`cip-router-careful`, `cip-ocr-document`, etc.).
3. Add `model_info` blocks to every alias for human discoverability.

Final `model_list` (every alias is a Mistral model — cheapest-suitable per the slice ask):

```yaml
litellm_settings:
  store_model_in_db: true             # ← NEW: enables runtime alias additions via /model/new
  success_callback: ["langfuse"]
  failure_callback: ["langfuse"]
  langfuse_public_key: os.environ/LANGFUSE_PUBLIC_KEY
  langfuse_secret_key: os.environ/LANGFUSE_SECRET_KEY
  langfuse_host: os.environ/LANGFUSE_HOST
  drop_params: true
  max_budget: 50
  budget_duration: "30d"

model_list:
  # ─── Bot: classification + routing ───────────────────────────────────────
  - model_name: cip-classifier
    litellm_params:
      model: mistral/open-mistral-nemo
      api_key: os.environ/MISTRAL_API_KEY
    model_info:
      description: "Stage-1 intent classifier. Tiny structured JSON out. Cheapest viable."
      use_for: ["intent_classify"]

  - model_name: cip-chat
    litellm_params:
      model: mistral/mistral-small-latest
      api_key: os.environ/MISTRAL_API_KEY
    model_info:
      description: "Legacy bot routing — single-stage tool selection. Slice 39B may deprecate."
      use_for: ["route_simple (legacy)"]

  - model_name: cip-router-fast
    litellm_params:
      model: mistral/open-mistral-nemo
      api_key: os.environ/MISTRAL_API_KEY
    model_info:
      description: "Stage-2 tool selection for low-stakes intents (cert_query, cert_action)."
      use_for: ["route_simple"]

  - model_name: cip-router-careful
    litellm_params:
      model: mistral/mistral-small-latest
      api_key: os.environ/MISTRAL_API_KEY
    model_info:
      description: "Stage-2 tool selection for HR-admin (mis-route = real damage). Better function-calling."
      use_for: ["route_careful"]

  - model_name: cip-reasoning
    litellm_params:
      model: mistral/mistral-large-latest
      api_key: os.environ/MISTRAL_API_KEY
    model_info:
      description: "Multi-step reasoning. Reserved for the few intents that need it."
      use_for: ["route_reasoning"]

  # ─── HR-service: matchers ────────────────────────────────────────────────
  - model_name: cip-lightweight
    litellm_params:
      model: mistral/open-mistral-nemo
      api_key: os.environ/MISTRAL_API_KEY
    model_info:
      description: "Text-only matchers (employee, cert_def). Cheapest non-vision option."
      use_for: ["employee_match", "cert_def_match"]

  - model_name: cip-document
    litellm_params:
      model: mistral/open-mistral-nemo
      api_key: os.environ/MISTRAL_API_KEY
    model_info:
      description: "Text-only document understanding (no OCR)."
      use_for: ["document_understand"]

  # ─── HR-service: vision / OCR ────────────────────────────────────────────
  - model_name: cip-vision
    litellm_params:
      model: mistral/pixtral-12b-2409
      api_key: os.environ/MISTRAL_API_KEY
    model_info:
      description: "Legacy vision-agent extraction. Cheapest pixtral option."
      use_for: ["vision_extract"]

  - model_name: cip-ocr-document
    litellm_params:
      model: mistral/pixtral-large-latest
      api_key: os.environ/MISTRAL_API_KEY
    model_info:
      description: "Full document OCR — quality-critical compliance docs."
      use_for: ["ocr_document"]

  - model_name: cip-ocr-document-small
    litellm_params:
      model: mistral/pixtral-12b-2409
      api_key: os.environ/MISTRAL_API_KEY
    model_info:
      description: "Draft / preview document OCR. Cheap path."
      use_for: ["ocr_document_small"]

  - model_name: cip-ocr-image
    litellm_params:
      model: mistral/pixtral-large-latest
      api_key: os.environ/MISTRAL_API_KEY
    model_info:
      description: "Photo of physical certificate — needs OCR + reasoning."
      use_for: ["ocr_image"]

  - model_name: cip-ocr-image-small
    litellm_params:
      model: mistral/pixtral-12b-2409
      api_key: os.environ/MISTRAL_API_KEY
    model_info:
      description: "Thumbnail / quick triage image OCR."
      use_for: ["ocr_image_small"]
```

`model_info` is documentation. LiteLLM exposes it via `/v1/model/info` for tooling but never reads it for routing decisions.

---

## Acceptance Criteria

- [ ] Migration `009_routing_rules.sql` applies cleanly; table exists with 13 seed rows visible via `SELECT * FROM routing_rules`.
- [ ] `tenant_settings.routing_overrides` column exists, defaults to `'{}'::jsonb`.
- [ ] `GET /admin/routing-rules?service=bot` returns the four `bot.*` rules. `GET …?service=hr-service` returns nine. Auth via `PLATFORM_ADMIN_TOKEN` enforced.
- [ ] `GET /admin/routing-rules?service=bot&tenantId=…` includes `overrides` JSONB in the response.
- [ ] hr-service `resolveAlias({service:'hr-service', purpose:'employee_match', tenantId})` returns `'cip-lightweight'`. Setting `tenant_settings.routing_overrides = '{"hr-service.employee_match":"cip-vision"}'` makes the same call return `'cip-vision'` within 5 minutes.
- [ ] Bot `resolveAlias({purpose:'route_simple', tenantId})` returns `'cip-chat'`.
- [ ] Every existing LLM call site goes through `callLLM(client, { ..., purpose })`. Searches for `client.chat.completions.create` outside `litellm.ts` return zero matches.
- [ ] Langfuse cloud (`https://cloud.langfuse.com`) shows traces tagged with `metadata.purpose` for every call. Filter dashboard by `purpose` works.
- [ ] LiteLLM `litellm_settings.store_model_in_db: true` is set; `/v1/model/info` returns aliases plus any added at runtime.
- [ ] All 12 aliases in the model_list resolve to a Mistral provider model with `MISTRAL_API_KEY`.
- [ ] `pnpm --filter @cip/teams-bot typecheck` passes.
- [ ] `pnpm --filter @cip/hr-service typecheck` passes.
- [ ] `pnpm --filter @cip/shared typecheck` passes.
- [ ] `pnpm -r run typecheck` passes.
- [ ] **No user-visible behaviour change.** The bot's existing flow uses `cip-chat` for routing exactly as today. hr-service's vision agent uses `cip-vision`. All previously-working flows continue working identically.

---

## Out of Scope

- LLM-as-classifier in the bot — Slice 39B.
- vision-agent refactor to actually use the new `ocr_document` / `ocr_image` purposes — separate slice. The seed rows for those purposes exist but no call site reads them yet.
- Tier-based budgets / per-team model access — Slice 40 (LiteLLM team management in `provision-tenant.sh`).
- Moving `routing_rules` and friends to `cip_platform` — see CS-022.
- Admin UI for editing routing rules — SQL is the interface.
- Streaming LLM responses.
- Two unrelated resolvers (in-process for hr-service, HTTP for bot) feels duplicative. **Don't unify.** The lifecycle differs (one is in the same process as the DB, one isn't), and a single helper that handles both ends up with branching logic that's worse than two clean implementations.

---

## Cross-Slice Notes

If existing `tenant_settings` doesn't have a row for the dev tenant, `getTenantRoutingOverrides()` returns `{}` (the COALESCE handles it). No bootstrap change required — but worth verifying:

```sql
SELECT tenant_id, routing_overrides FROM tenant_settings;
```

If empty for the dev tenant, [scripts/bootstrap.sh](scripts/bootstrap.sh) doesn't currently seed `tenant_settings` rows on demand. A row gets created the first time the tenant calls `get_tenant_channel_config` MCP tool (the existing tool inserts on miss). If you want overrides immediately available for testing, insert a row by hand once.

### CS-022 (NEW, OPEN)

```
### CS-022
- Logged in: Slice 39A (Per-Purpose LLM Routing Foundation)
- Affects: Slice 05A (HR domain schema) + future platform-config refactor
- Files:
  - packages/hr-service/src/db/migrations/009_routing_rules.sql
  - packages/hr-service/src/db/migrations/004_tenants.sql
  - packages/hr-service/src/db/migrations/...tenant_settings...
- Status: OPEN
- Issue: routing_rules joins tenants and tenant_settings as platform-level
  config that lives in cip_hr (hr-service's DB). Architecturally these
  belong in cip_platform (platform-core's DB). The routing table
  perpetuates the existing smell rather than fixing it.
- Why it matters: cross-service queries like "how much did Acme spend on
  bot routing this month" would naturally join routing_rules with tenant
  metadata, which is in the same DB today — fine for now. But if a
  future tenant-onboarding workflow in platform-core wants to seed
  routing_rules at provision time, it'd need to either reach across to
  cip_hr or send a request to hr-service. Adds friction.
- Fix: A future cleanup slice migrates tenants, tenant_identity_providers,
  tenant_settings, routing_rules → cip_platform. hr-service queries
  these via an internal /admin endpoint on platform-core. Estimated
  effort: 1–2 days, mostly mechanical (pg_dump + repoint callers).
  Defer until platform-core has more than one consumer for this data.
```

---

## Commit

```
slice(39A): per-purpose LLM routing foundation

routing_rules table + tenant_settings.routing_overrides; resolveAlias()
helpers (in-process for hr-service, HTTP for bot) with 5-min cache;
purpose-tagged callLLM wrapper that injects metadata for Langfuse.

LiteLLM config rewritten to point all aliases at Mistral, with
store_model_in_db: true so runtime alias additions persist. Twelve
aliases now declared — five in active use, seven dormant pending
Slice 39B + future vision-agent refactor.

No user-visible behaviour change. Foundation only.
```
