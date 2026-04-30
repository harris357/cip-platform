# Slice 41 — Langfuse-hosted Prompts

> **Prerequisite:** Slice 39A (per-purpose routing + LiteLLM ↔ Langfuse wiring) complete.
> **Package:** `@cip/shared`, `@cip/teams-bot`, `@cip/hr-service`
> **Verify:** `pnpm -r run typecheck && bash scripts/seed-langfuse-prompts.ts && curl … | grep prompt_version`

---

## Why This Slice Exists

Today, four prompts live as inline string literals in app code:

| Location | Purpose |
|---|---|
| `packages/teams-bot/src/intent/classifier.ts:24` `SYSTEM_PROMPT` | Stage-1 intent classification |
| `packages/hr-service/src/modules/certifications/agents/vision-agent/prompts.ts` | Vision OCR extraction |
| `packages/hr-service/src/modules/certifications/activities/match-employee.activity.ts:93` (inline) | Fuzzy employee match LLM tiebreaker |
| `packages/hr-service/src/modules/certifications/activities/match-cert-definition.activity.ts:78` (inline) | Fuzzy cert-definition match |

Tuning any one of these requires: edit code → CI build → push → deploy
→ smoke test. ~5 minutes per iteration. When dialing in classifier
accuracy, OCR field coverage, or matcher false-positive rate, that's
expensive.

Langfuse Cloud (already wired up via Slice 39A's `success_callback`)
ships a native Prompt Management feature. Versioned prompts, web UI
editing, label-based promotion (`staging` → `production`), runtime
fetch with caching, and automatic linkage to traces. **Same Langfuse
project we already use for traces — no new dependency, no new account,
no new SDK auth.**

After this slice: edit a prompt in the Langfuse UI → save with
`production` label → wait up to 5 min for cache TTL → live. Same
ops UX as `routing_rules` SQL changes.

---

## What You Are Building

```
packages/shared/src/clients/
  langfuse.ts                                 ← MOD: export getPrompt() + types
  prompts/                                    ← NEW: hardcoded fallback strings
    index.ts                                  ← NEW: export FALLBACKS map
    bot-intent-classify.ts                    ← NEW
    hr-vision-extract.ts                      ← NEW
    hr-employee-match.ts                      ← NEW
    hr-cert-def-match.ts                      ← NEW

packages/teams-bot/src/intent/classifier.ts                                  ← MOD: getPrompt()
packages/hr-service/src/modules/certifications/agents/vision-agent/nodes.ts  ← MOD
packages/hr-service/src/modules/certifications/activities/match-employee.activity.ts        ← MOD
packages/hr-service/src/modules/certifications/activities/match-cert-definition.activity.ts ← MOD

scripts/seed-langfuse-prompts.ts              ← NEW: idempotent uploader

packages/teams-bot/helm/values.yaml           ← MOD: LANGFUSE_PROMPT_LABEL env
packages/hr-service/helm/values.yaml          ← MOD: LANGFUSE_PROMPT_LABEL env
```

---

## Read Before Writing

- `packages/shared/src/clients/litellm.ts` (style reference — small focused client)
- `packages/teams-bot/src/intent/classifier.ts` (where SYSTEM_PROMPT lives today)
- `packages/hr-service/src/modules/certifications/agents/vision-agent/prompts.ts` (existing prompt module pattern)
- `infra/helm/litellm/values.yaml` (Langfuse credentials env vars: `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_HOST`)
- Langfuse JS SDK Prompt API docs (`langfuse.getPrompt(name, version, options)`)

Do **not** modify any other prompt-using code in this slice. If a new
prompt site emerges in another slice, it'll use the same `getPrompt()`
helper as a one-liner.

---

## Hard Rules (Seven Non-Negotiables)

1. **Every `getPrompt()` call has a fallback path.** If Langfuse is
   unreachable / the prompt doesn't exist / the response is malformed,
   return the baked-in fallback string. **Never fail an LLM call
   because the prompt fetch failed.**
2. **Prompt names mirror `routing_rules.purpose`.** `bot.intent_classify`,
   `hr-service.vision_extract`, etc. Same scheme, same key shape — one
   place to look up "what model + what prompt does service X use for
   purpose Y."
3. **Caching is mandatory.** 5-minute TTL in-memory, matches the
   existing `routing_rules` and `tool-discovery` cache patterns. The
   Langfuse SDK has its own cache; ours is an additional layer to
   ensure consistent latency profile.
4. **Templating is Jinja2.** Both Langfuse-fetched and fallback
   prompts use Jinja2 syntax (`{{ var }}`, `{% if %}`, `{% for %}`,
   filters). Simple `{{ var }}` substitution is a Jinja2 subset, so
   today's flat prompts work without modification. Future prompts can
   add conditional sections (e.g., per-role category lists) and
   candidate-list loops without code changes.
5. **Fallbacks are byte-for-byte identical to today's strings.** No
   trimming, rewording, or restructuring during this slice. The point
   is to *enable* tuning; tuning happens after the slice lands. Any
   prompt change rides as a separate Langfuse edit.
6. **`LANGFUSE_PROMPT_LABEL` env defaults to `production`.** Both bot
   and hr-service helm values set it explicitly. Never read prompts
   from an unlabeled or `latest` version.
7. **Trace linkage is automatic.** When you pass a `PromptHandle` to
   `callLLM()`, the helper attaches `metadata.prompt_name` and
   `metadata.prompt_version` so Langfuse traces show which prompt
   version served the call.

---

## The architecture

```
[call site]
   const prompt = await getPrompt({ name: 'bot.intent_classify', tenantId });
   await callLLM(client, {
     model: alias,
     messages: [{ role: 'system', content: prompt.compile({...}) }, ...],
     purpose: 'bot.intent_classify',
     promptHandle: prompt,         ← NEW: callLLM injects prompt_name + prompt_version into metadata
     tenantId,
   });
   │
   ▼
[getPrompt()]
   1. In-memory cache lookup (key = `${name}:${label}`, 5-min TTL)
   2. On miss:
      - langfuse.getPrompt(name, undefined, { label }) — Langfuse SDK
        fetches from cloud, has its own retry + cache
      - On exception or null result → fall back to FALLBACKS[name]
        (baked-in default), log "[prompts] fallback: <reason>"
   3. Return PromptHandle { name, version, compile(vars?) }
   │
   ▼
[callLLM()] (mod from Slice 39A)
   If args.promptHandle is set, merge into metadata:
     metadata.prompt_name = handle.name
     metadata.prompt_version = String(handle.version)
   │
   ▼
[LiteLLM proxy → provider, success_callback → Langfuse]
   Trace shows prompt_name / prompt_version alongside purpose / tenantId
```

---

## `@cip/shared/clients/langfuse.ts` (MOD)

Add `getPrompt()` and the `PromptHandle` type. Existing exports
preserved (Langfuse client used by other components stays unchanged).

**Jinja2 engine.** Use `@huggingface/jinja` for the fallback compile
path (~30 KB, purpose-built for LLM prompt templating, used in HF
Transformers.js). Langfuse-fetched prompts compile via the SDK's own
`compile()` method, which handles Jinja2 server-side-stored templates
transparently. Both engines are Jinja2-compatible — same syntax,
identical output for the same vars.

Add `@huggingface/jinja` to `packages/shared/package.json` deps.

```typescript
import { Langfuse } from 'langfuse';
import { Template } from '@huggingface/jinja';
import { FALLBACKS } from './prompts/index.js';

const TTL_MS = 5 * 60 * 1000;

export interface PromptHandle {
  name:    string;
  version: number | null;            // null when served from fallback
  compile: (vars?: Record<string, unknown>) => string;
  source:  'langfuse' | 'fallback';  // diagnostic — surfaces in traces
}

interface CacheEntry {
  handle:    PromptHandle;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
let _client: Langfuse | null = null;

function getLangfuseClient(): Langfuse {
  if (_client) return _client;
  _client = new Langfuse({
    publicKey: process.env['LANGFUSE_PUBLIC_KEY'] ?? '',
    secretKey: process.env['LANGFUSE_SECRET_KEY'] ?? '',
    baseUrl:   process.env['LANGFUSE_HOST'] ?? 'https://cloud.langfuse.com',
  });
  return _client;
}

// Pre-compile fallback templates once at module load — Jinja2 parsing is
// non-trivial and would be wasted work on every classify() call.
const compiledFallbacks: Map<string, Template> = new Map();
for (const [name, text] of Object.entries(FALLBACKS)) {
  try {
    compiledFallbacks.set(name, new Template(text));
  } catch (err) {
    console.error(`[prompts] failed to pre-compile fallback for '${name}': ${err instanceof Error ? err.message : String(err)}`);
  }
}

function compileFallback(name: string, vars?: Record<string, unknown>): string {
  const tmpl = compiledFallbacks.get(name);
  if (!tmpl) {
    console.error(`[prompts] no fallback registered for '${name}' — empty prompt!`);
    return '';
  }
  try {
    return tmpl.render(vars ?? {});
  } catch (err) {
    console.error(`[prompts] fallback render failed for '${name}': ${err instanceof Error ? err.message : String(err)}`);
    return FALLBACKS[name] ?? '';
  }
}

function fallbackHandle(name: string): PromptHandle {
  return {
    name,
    version: null,
    source:  'fallback',
    compile: (vars) => compileFallback(name, vars),
  };
}

export async function getPrompt(args: {
  name:     string;
  tenantId: string;
  label?:   string;
}): Promise<PromptHandle> {
  const label = args.label ?? process.env['LANGFUSE_PROMPT_LABEL'] ?? 'production';
  const cacheKey = `${args.name}:${label}`;

  const cached = cache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) return cached.handle;

  let handle: PromptHandle;
  try {
    const lf = getLangfuseClient();
    const lfPrompt = await lf.getPrompt(args.name, undefined, { label });
    if (!lfPrompt) {
      console.warn(`[prompts] langfuse returned null for '${args.name}@${label}', using fallback`);
      handle = fallbackHandle(args.name);
    } else {
      handle = {
        name:    args.name,
        version: lfPrompt.version,
        source:  'langfuse',
        // SDK's compile() handles Jinja2 server-side templates transparently
        // when the prompt is configured with type: 'chat' or 'text' + Jinja2.
        compile: (vars) => lfPrompt.compile((vars ?? {}) as Record<string, string>),
      };
    }
  } catch (err) {
    console.warn(`[prompts] langfuse fetch failed for '${args.name}@${label}': ${err instanceof Error ? err.message : String(err)} — using fallback`);
    handle = fallbackHandle(args.name);
  }

  cache.set(cacheKey, { handle, expiresAt: Date.now() + TTL_MS });
  return handle;
}

export function _resetPromptCache(): void {
  cache.clear();
}
```

### Why `@huggingface/jinja` and not `nunjucks`

`nunjucks` (Mozilla's full Jinja2 port) is feature-complete but ~200 KB
and built for HTML rendering — async loaders, autoescape, sandboxes,
extensions we don't need. `@huggingface/jinja` is a focused
~30 KB JS implementation specifically for LLM prompt templates. It
supports the Jinja2 subset that matters for prompts: variables,
`{% if %}`, `{% for %}`, filters (`upper`, `lower`, `length`,
`default`, `join`, `selectattr`, etc.), `loop.index`, `{%- ... -%}`
whitespace control. That covers every prompt template feature we'd
plausibly need. If a future use case demands a Jinja2 feature
`@huggingface/jinja` doesn't support, switch to nunjucks then.

---

## `@cip/shared/clients/prompts/*.ts` (NEW — fallback strings)

Each file exports a single string identical to today's prompt:

```typescript
// packages/shared/src/clients/prompts/bot-intent-classify.ts
export const BOT_INTENT_CLASSIFY = `
You are a fast intent classifier for a workplace HR/compliance bot.
Classify the user's message into exactly one category:

- "chitchat"    : greetings, thanks, social pleasantries. Emit a brief
                  friendly inline_reply (1 sentence).
...
`.trim();
```

(Use the EXACT current text from each call site — copy-paste, no edits.)

```typescript
// packages/shared/src/clients/prompts/index.ts
import { BOT_INTENT_CLASSIFY } from './bot-intent-classify.js';
import { HR_VISION_EXTRACT }  from './hr-vision-extract.js';
import { HR_EMPLOYEE_MATCH }  from './hr-employee-match.js';
import { HR_CERT_DEF_MATCH }  from './hr-cert-def-match.js';

export const FALLBACKS: Record<string, string> = {
  'bot.intent_classify':     BOT_INTENT_CLASSIFY,
  'hr-service.vision_extract': HR_VISION_EXTRACT,
  'hr-service.employee_match': HR_EMPLOYEE_MATCH,
  'hr-service.cert_def_match': HR_CERT_DEF_MATCH,
};
```

The fallback files are version-controlled. They ARE the codebase's
prompts when Langfuse is unreachable AND the always-shippable baseline
that disaster-recovery falls back to.

---

## Updating call sites

Each of the four sites becomes (sketch):

```typescript
// classifier.ts
import { getPrompt } from '@cip/shared';

export async function classify(message: string, ctx: BotAuthContext): Promise<ClassifyResult> {
  let alias: string | null = null;
  try {
    alias = await resolveAlias({ purpose: 'intent_classify', tenantId: ctx.tenantId });
    const prompt = await getPrompt({ name: 'bot.intent_classify', tenantId: ctx.tenantId });
    const client = createLiteLLMClient({ tenantId: ctx.tenantId, virtualKey: ctx.tenantConfig.litellmVirtualKey });

    const resp = await callLLM(client, {
      model: alias,
      messages: [
        { role: 'system', content: prompt.compile() },
        { role: 'user',   content: message },
      ],
      response_format: { type: 'json_object' },
      temperature: 0,
      purpose:      'bot.intent_classify',
      promptHandle: prompt,                ← NEW
      tenantId:     ctx.tenantId,
    });

    const text = resp.choices[0]?.message.content ?? '';
    return { classification: ClassificationSchema.parse(JSON.parse(text)), alias };
  } catch (err) {
    console.warn(`[classifier] failed: ${err instanceof Error ? err.message : String(err)}`);
    return { classification: null, alias };
  }
}
```

For matchers, Jinja2 lets the prompt template handle list formatting,
so the call site passes raw arrays:

```typescript
// match-employee.activity.ts (sketch)
const prompt = await getPrompt({ name: 'hr-service.employee_match', tenantId });
const text = prompt.compile({
  extractedName:  extractedName ?? '(not found)',
  extractedEmail: extractedEmail ?? '(not found)',
  candidates,    // raw array of { id, fullName, email } — the prompt iterates
});
```

The Langfuse-hosted prompt for `hr-service.employee_match` can iterate:

```jinja
Match a certificate holder to one of these candidates.

Certificate holder:
  Name:  {{ extractedName }}
  Email: {{ extractedEmail }}

Candidates:
{% for c in candidates %}
{{ loop.index }}. REF={{ loop.index }} | Name="{{ c.fullName }}" | Email="{{ c.email }}"
{% endfor %}

If one candidate is clearly the same person, reply with ONLY their REF
number. If you are not confident, reply with exactly: NO_MATCH.
Do not explain.
```

Operators can change the candidate-list format (add a department
column, change separator, switch to numbered bullets) by editing in
Langfuse — no code change needed. Today's `candidates.map(...).join('\n')`
formatting moves out of code into the prompt template, where it
belongs.

The fallback file (`packages/shared/src/clients/prompts/hr-employee-match.ts`)
is the same Jinja2 template — both Langfuse and fallback share syntax.

### Conditional sections — the strongest Jinja2 case

The classifier prompt currently always lists `hr_admin` even for
users without HR permissions. With Jinja2, the prompt can adapt:

```jinja
You are a fast intent classifier...
- "chitchat"    : ...
- "cert_query"  : ...
- "cert_action" : ...
{% if has_hr_role %}
- "hr_admin"    : the user wants to manage employees, roles, or permissions.
{% endif %}
- "reasoning"   : ...
```

Call site passes `has_hr_role: ctx.roles.includes('hr')`. Stage 1
stops emitting `hr_admin` for non-HR users — they wouldn't have those
tools to call anyway, so it's a wasted classification path. Smaller
enum → faster + more accurate classification.

This is opt-in per-prompt; the initial fallbacks have no conditional
logic (per Hard Rule #5: byte-identical to today's strings). Adding
conditional sections is a future Langfuse edit + matching fallback
update.

---

## `callLLM()` change in `@cip/shared/clients/litellm.ts`

Add an optional `promptHandle` arg that injects prompt metadata:

```typescript
export async function callLLM(
  client: OpenAI,
  args: ChatCompletionCreateParamsNonStreaming & {
    purpose:       string;
    tenantId:      string;
    promptHandle?: PromptHandle;     // NEW
    extraMeta?:    Record<string, string | number | boolean>;
  },
): Promise<ChatCompletion> {
  const { purpose, tenantId, promptHandle, extraMeta, ...rest } = args;
  const metadata: Record<string, string> = {
    purpose,
    tenantId,
    ...(promptHandle ? {
      prompt_name:    promptHandle.name,
      prompt_version: String(promptHandle.version ?? 'fallback'),
      prompt_source:  promptHandle.source,
    } : {}),
    ...Object.fromEntries(Object.entries(extraMeta ?? {}).map(([k, v]) => [k, String(v)])),
  };
  return client.chat.completions.create({ ...rest, metadata });
}
```

Three new fields surface in Langfuse traces: `prompt_name`,
`prompt_version`, `prompt_source` (`langfuse` or `fallback`).
Filterable, groupable.

---

## `scripts/seed-langfuse-prompts.ts` (NEW)

Idempotent uploader — run once after a fresh Langfuse project to
populate the `production` label with the same text as the fallbacks.

```typescript
import { Langfuse } from 'langfuse';
import { FALLBACKS } from '@cip/shared/clients/prompts/index.js';

async function main(): Promise<void> {
  const lf = new Langfuse({
    publicKey: process.env['LANGFUSE_PUBLIC_KEY']!,
    secretKey: process.env['LANGFUSE_SECRET_KEY']!,
    baseUrl:   process.env['LANGFUSE_HOST'] ?? 'https://cloud.langfuse.com',
  });

  for (const [name, text] of Object.entries(FALLBACKS)) {
    // createPrompt is idempotent if the same text is uploaded twice — Langfuse
    // detects duplicates and returns the existing version. Different text
    // creates a new version.
    //
    // type: 'text' (single string prompt, vs 'chat' which is a messages array).
    // Langfuse infers Jinja2 templating from {%...%} blocks in the body — no
    // explicit type flag needed; the SDK's compile() Just Works for both
    // mustache and Jinja2 templates.
    const created = await lf.createPrompt({
      name,
      type:   'text',
      prompt: text,
      labels: ['production'],
    });
    console.log(`[seed] ${name} → version ${created.version}`);
  }

  await lf.shutdownAsync();
}

main().catch(err => { console.error(err); process.exit(1); });
```

Run via:

```bash
LANGFUSE_PUBLIC_KEY=… LANGFUSE_SECRET_KEY=… \
  pnpm tsx scripts/seed-langfuse-prompts.ts
```

Output:

```
[seed] bot.intent_classify → version 1
[seed] hr-service.vision_extract → version 1
[seed] hr-service.employee_match → version 1
[seed] hr-service.cert_def_match → version 1
```

Re-running with the same text → no new versions (Langfuse dedupes).

---

## Helm values: `LANGFUSE_PROMPT_LABEL`

```yaml
# packages/teams-bot/helm/values.yaml
env:
  ...
  # Slice 41: which Langfuse prompt label to fetch from. 'production' is
  # the canonical version; promote a draft via Langfuse UI to take effect.
  # Override to 'staging' for a single canary pod to A/B-test a new prompt
  # version without affecting other tenants.
  LANGFUSE_PROMPT_LABEL: "production"
```

Same in `packages/hr-service/helm/values.yaml`.

---

## Acceptance Criteria

- [ ] `pnpm tsx scripts/seed-langfuse-prompts.ts` runs successfully
      and lists 4 prompts uploaded with `production` label.
- [ ] All four prompts visible in Langfuse Cloud UI under "Prompts" tab.
- [ ] `getPrompt({ name: 'bot.intent_classify', tenantId: '<dev>' })`
      returns a `PromptHandle` with `source: 'langfuse'` and
      `version: 1` (or higher).
- [ ] Each call site uses `getPrompt()` instead of an inline string.
      Searches for `SYSTEM_PROMPT =` and inline prompt template literals
      return zero matches outside `packages/shared/src/clients/prompts/`.
- [ ] Editing a prompt in the Langfuse UI → re-labeling as `production`
      → takes effect within 5 min in running pods, no deploy.
- [ ] Each Langfuse trace shows `metadata.prompt_name`,
      `metadata.prompt_version`, `metadata.prompt_source` alongside
      the existing `purpose` and `tenantId`.
- [ ] Disconnecting Langfuse (e.g. `kubectl set env … LANGFUSE_HOST=
      http://invalid:9999`) doesn't break the bot. Logs show
      `[prompts] langfuse fetch failed: ... — using fallback` and
      classifier still works using the baked-in fallback. Traces
      tagged `prompt_source: fallback`.
- [ ] A user-edited Langfuse prompt with a syntax error in `{{var}}`
      or `{% if %}` substitution doesn't crash a turn — the helper's
      compile() gracefully degrades, classifier's existing try/catch
      handles it.
- [ ] Jinja2 features work end-to-end: edit `hr-service.employee_match`
      in Langfuse to use `{% for c in candidates %}…{% endfor %}` and
      pass `candidates: [{...}, {...}]` from the matcher activity →
      the prompt renders the list correctly. Verify in Langfuse trace
      that the rendered prompt contains the iterated entries.
- [ ] `pnpm --filter @cip/teams-bot typecheck` passes.
- [ ] `pnpm --filter @cip/hr-service typecheck` passes.
- [ ] `pnpm --filter @cip/shared typecheck` passes.
- [ ] `pnpm -r run typecheck` passes.

---

## Out of Scope

- **Per-tenant prompts.** `getPrompt()` accepts `tenantId` for future
  scoping but right now all tenants share the `production` label.
  Real per-tenant work needs the Langfuse Prompt API extended (or a
  per-tenant override table in our DB) — a future slice.
- **Prompt evals / quality scoring.** Langfuse has eval features.
  Outside this slice's scope.
- **Tool definitions in Langfuse.** Tool catalogs live in MCP server
  registrations. Don't duplicate; that's where they belong.
- **Live A/B testing infrastructure.** For now: one staging label,
  one production label. Promote manually. Slice 42+ could add a per-
  tenant routing table mapping tenant → prompt label.
- **Removing the fallback files.** Keep them forever — the
  disaster-recovery floor. Treat them as "what should the prompt be
  if Langfuse vanishes tomorrow."
- **`nunjucks` (full Jinja2 port) escape hatch.** We're shipping with
  `@huggingface/jinja` which covers the prompt-templating subset of
  Jinja2. If a future prompt needs features `@huggingface/jinja`
  doesn't support (sandboxed expressions, custom async loaders,
  template inheritance), swap to `nunjucks` then. Not now.
- **Pre-loading prompts on app startup.** Could call `getPrompt()`
  for every known name in a startup hook to warm the cache before
  the first user request. Worth it if first-call latency surprises
  matter. Defer until measured.
- **Prompt-version pinning at the call site.** `getPrompt()` always
  fetches the latest version with the configured label. If a future
  use case needs "always use prompt v3 regardless of label," add an
  optional `version` arg to the helper.

---

## Cross-Slice Notes

If Slice 39A's `metadata` propagation through LiteLLM → Langfuse is
broken (custom metadata fields aren't surfacing in traces), the
prompt_name / prompt_version tags won't show up either. Verify Slice 39A's
acceptance criterion ("Langfuse cloud shows traces tagged with
metadata.purpose") still passes before relying on prompt-tagged traces.

`@cip/shared` consumers (hr-service, teams-bot, platform-core) will
need a rebuild after `langfuse.ts` changes — `pnpm --filter @cip/shared
build` before running typecheck on dependents. Same pattern as Slice
39A.

---

## Tradeoffs / Risks

1. **Prompt drift between Langfuse and the fallback file.** Operators
   editing in Langfuse won't update `packages/shared/src/clients/prompts/`.
   Over time, the fallback becomes stale. Mitigation: a periodic
   reconciliation script (compares Langfuse `production` label with the
   fallback file and warns on diffs). Optional, deferred.
2. **One more system that has to be up for prompt edits to propagate.**
   Langfuse outage doesn't break the bot (fallback works), but it does
   mean prompt edits don't propagate. Acceptable for cloud Langfuse's
   SLA.
3. **Slower first-call after pod start.** First fetch from Langfuse
   adds ~200-400ms (DNS + TLS + API). Subsequent calls hit the cache.
   Mitigation: warm the cache at startup by calling `getPrompt()` for
   each known name in a startup hook. Not free, but worth it for
   predictable latency. Optional, deferred.
4. **Loss of git-as-source-of-truth.** "What's the production prompt
   right now?" requires looking in Langfuse, not `git log`. The
   fallback file gives a reference but isn't authoritative once
   editing in Langfuse begins. Some teams find this disorienting.
   Mitigation: weekly cron that snapshots Langfuse `production` to a
   `prompts-snapshot/` directory committed to the repo. Optional,
   deferred.

---

## Estimated Size

Comparable to Slice 39A — 1 helper + 4 fallback files + 4 call site
updates + 1 seed script + 2 helm values edits. Roughly 1 day of work.

---

## Commit

```
slice(41): host LLM prompts in Langfuse (Jinja2) with code-resident fallbacks

Replaces four inline prompt strings (classifier, vision-extract,
employee-match, cert-def-match) with @cip/shared getPrompt() calls.
The helper fetches from Langfuse Cloud (label-scoped, defaults to
'production'), caches 5 min in-memory, and falls back to the
byte-identical baked-in copies in packages/shared/src/clients/prompts/
on any failure (Langfuse down, prompt missing, malformed response).

Templating is Jinja2 — both Langfuse-fetched prompts (compiled by the
SDK) and fallbacks (compiled by @huggingface/jinja, ~30 KB, purpose-
built for LLM prompts). Initial fallbacks are flat (no Jinja2 logic)
since Hard Rule #5 keeps them byte-identical to today's strings, but
operators can add {% if %} conditionals or {% for %} loops in
Langfuse — e.g. iterate over candidates in matcher prompts, omit
hr_admin from the classifier enum for non-HR users — without code
changes.

callLLM() extended to attach metadata.prompt_name +
metadata.prompt_version + metadata.prompt_source so Langfuse traces
show which prompt version served each call (and whether it came from
Langfuse or fallback).

scripts/seed-langfuse-prompts.ts uploads the fallbacks idempotently
to populate a fresh Langfuse project. Re-running with the same text
is a no-op (Langfuse dedupes by content hash).

Operators can now tune prompts in the Langfuse UI without rebuilding.
LANGFUSE_PROMPT_LABEL env (default 'production') lets a canary pod
fetch 'staging' for A/B testing.
```
