# LLM Provider Notes — Mistral via LiteLLM

> **Scope:** What we need to know about the LLM providers behind our LiteLLM gateway. Architectural rule: *do not bake model-specific workarounds into application code.* If a provider has a quirk, we either (a) handle it in our prompts using canonical patterns that work everywhere, or (b) push the workaround to LiteLLM. Application code reads/writes OpenAI-style messages and trusts the gateway.

> **Why this doc exists:** during Slice 47b we hit two production failures (`bot.meta_compose` 400, `bot.triage` 400) caused by Mistral rejecting system-only conversations. The first time I patched it inline; the second time I patched it inline again. Both fixes were Mistral-specific reactions, not principled changes. This doc captures what's actually true about each provider so future prompts and runtime code are written canonically.

> **Last reviewed:** 2026-05-01. Re-verify when Mistral ships major model versions or LiteLLM upgrades.

---

## TL;DR

1. **Always include at least one `user` message in chat completions.** Not just for Mistral — it's the canonical pattern Mistral itself documents. Single-system-message requests are an anomaly; anything that looks like one in our codebase is a bug.
2. **Use `response_format: { type: 'json_object' }` AND keep "Return ONLY a JSON object" in the prompt.** Mistral docs: explicit JSON requests in the prompt are *"advisable but not strictly required"* — but cheap insurance.
3. **`tool_choice` accepts `'auto' | 'any' | 'none'` on Mistral.** No `'required'` value (which OpenAI/Anthropic accept). We use `'auto'` everywhere — safe.
4. **Our model identifiers are valid via LiteLLM.** `mistral/open-mistral-nemo`, `mistral/mistral-small-latest`, `mistral/mistral-large-latest`, `mistral/mistral-embed` — all explicitly listed in LiteLLM's Mistral provider docs.
5. **`pixtral-12b-2409` deprecates 2025-12-02.** Successor: Ministral 3 14B. We have time but should track the migration in a future slice.

---

## What's actually documented (with refs)

### Mistral chat completion message structure

From [Mistral function calling docs](https://docs.mistral.ai/capabilities/function_calling/):

> *"system* → user → assistant function call 1 → tool result 1 → assistant → user"*

The `system*` is marked optional with an asterisk. **What's NOT optional in practice: the user turn.** The official Mistral example always has a user message immediately after the system message.

**The empirical "Conversation must have at least one message" 400 error we hit twice is not in Mistral's published docs, but it's consistent with how their examples are written.** Don't expect them to document it as a constraint — they treat "user message present" as the obvious default.

### Mistral function calling

From [function calling docs](https://docs.mistral.ai/capabilities/function_calling/):

- Tool format: standard OpenAI shape — `{ type: 'function', function: { name, description, parameters } }`
- `tool_choice`: `'auto'` (default), `'any'` (force tool use), `'none'` (forbid tool use). **No `'required'`.**
- `parallel_tool_calls`: `true` (default) or `false`. We don't pass it, so we get parallel.
- The developer is responsible for executing tools and returning `role: 'tool'` messages with results. We do this via `executeTool()` + LangGraph's ToolMessage.

### Mistral JSON mode

From [JSON mode docs](https://docs.mistral.ai/capabilities/structured_output/json_mode/):

- `response_format = { "type": "json_object" }` enables it.
- *"we still recommend to explicitly ask the model to return a JSON object and the format"* — our `bot.triage` and (former) `bot.intent_classify` prompts already do this.
- "Custom structured outputs" (JSON Schema) are recommended over loose JSON mode *"whenever possible"*. We're not using JSON Schema today; possible improvement for the triage path.

### Mistral system prompts

From [prompting guide](https://docs.mistral.ai/guides/prompting_capabilities/):

> *"If you cannot control the system prompt, you can still include the general context and instructions in the user prompt by concatenating them with the actual query."*

Implication: Mistral treats system and first-user messages as equivalent in practice. This is consistent with the empirical "must have user message" behavior — what matters is that the model has *something* to respond to, not specifically a `user` role.

### Mistral models we use

Verified against [models overview](https://docs.mistral.ai/getting-started/models/models_overview/) and [LiteLLM Mistral provider](https://docs.litellm.ai/docs/providers/mistral):

| Our alias | Model ID | Status | Notes |
|---|---|---|---|
| `cip-classifier` | `mistral/open-mistral-nemo` (12B) | Active (Open tier) | Fast/cheap. Used for triage + meta_compose. Hallucinates enums on tight constrained outputs — we mitigate with Zod transform + alias map. |
| `cip-router-careful` | `mistral/mistral-small-latest` | Active (Premier) | Function calling. Adequate for ~30 tools; surface-phrase match dominates over `whenNotToUse` reasoning. |
| `cip-reasoning` | `mistral/mistral-large-latest` | Active (Premier) | Reserved fallback. Stronger function-calling adherence at higher cost. |
| `cip-embed` | `mistral/mistral-embed` | Active (Premier) | 1024-dim. We pass `encoding_format: 'float'` to avoid base64 surprises through the proxy. |
| `cip-vision`, `cip-ocr-document-small`, `cip-ocr-image-small` | `mistral/pixtral-12b-2409` | **Deprecates 2025-12-02 / retires 2025-12-31** | Successor: Ministral 3 14B. Future-slice migration. |
| `cip-ocr-document`, `cip-ocr-image` | `mistral/pixtral-large-latest` | Deprecates 2026-02-27 / retires 2026-05-31 | Successor: Mistral Large 3. |

### LiteLLM passthrough behavior

From [LiteLLM Mistral provider](https://docs.litellm.ai/docs/providers/mistral):

- **LiteLLM does NOT auto-inject a user message when one is missing.** Whatever we send goes to Mistral as-is.
- **LiteLLM does NOT collapse multiple system messages.** It documents prepending a system message for `reasoning_effort` magistral configurations, but it doesn't synthesize one for us.
- **LiteLLM passes our `metadata` field through to the Langfuse callback.** This is how `purpose`, `tenantId`, prompt provenance, and (Slice 47c) `trace_id` reach Langfuse traces.
- No documented "Conversation must have at least one message" workaround. **It's our problem to solve in prompts.**

---

## Application-code rules (what we should do, given the above)

These are normative for any future LLM call site in this codebase:

### 1. Every chat completion includes a user message

Single-message (system-only) requests are forbidden by convention even though our code path doesn't enforce it at the type level. **If a node calls `callLLM`, its `messages` array must contain at least one user-role message.**

For prompts where the "user input" is naturally embedded (e.g., a triage that classifies the latest message), the canonical shape is:

```ts
messages: [
  { role: 'system', content: prompt.compile({...}) },
  { role: 'user',   content: state.latestUserText },
],
```

For prompts where there's truly no user input (e.g., a meta_compose that just renders a menu from the tool list), use a synthetic user turn that mirrors the implied request:

```ts
messages: [
  { role: 'system', content: prompt.compile({ tools: ... }) },
  { role: 'user',   content: 'Show me the menu of what you can help with.' },
],
```

The synthetic user turn is **not** a Mistral workaround. It's the canonical pattern Mistral and OpenAI both use in their reference examples. If we ever swap to Claude or another provider via LiteLLM, the same code keeps working.

### 2. JSON-output prompts include the JSON instruction in the prompt body

Even though `response_format: { type: 'json_object' }` enforces structurally-valid JSON, Mistral docs *recommend* repeating the instruction in the prompt. We already do this in `bot.triage`. New JSON-output prompts should follow suit.

### 3. Tool descriptions live in MCP annotations, not prompts

Confirmed by the prompting guide's emphasis on "structured" inputs. Our two-channel approach (function-calling `tools` parameter for the validation contract + system-prompt markdown block for `whenToUse`/`whenNotToUse`/etc.) maps cleanly to Mistral's recommendation to use Markdown in prompts.

### 4. `tool_choice` stays `'auto'` unless we have a reason

Mistral's `'any'` (force tool use) and `'none'` (forbid) are the only other options. We don't pass `'required'` (which would be an OpenAI-only value).

### 5. Provider-version-specific code = LiteLLM's job

If we hit a new Mistral 4xx that LiteLLM should be translating: file an upstream issue, don't patch it inline. Prefer prompt restructuring over runtime conditionals.

---

## Open questions / not yet investigated

- **Whether `mistral-small-latest` follows `whenNotToUse` annotations more reliably with longer per-tool blocks.** Empirically it ignores them sometimes. May warrant a Slice that A/Bs `mistral-small-latest` vs `mistral-large-latest` for the planner.
- **Whether the new `Mistral Small 4` (model name TBD via API alias) handles 30-tool catalogs better than the current `mistral-small-latest`.** Worth a separate test.
- **Whether `response_format: { type: 'json_schema', json_schema: {...} }` (strict JSON Schema mode) works on Mistral via LiteLLM.** Documented as recommended over `json_object` for reliability, but I haven't verified the LiteLLM proxy translates correctly.

---

## Where this comes from

| Topic | Reference URL |
|---|---|
| Mistral function calling | https://docs.mistral.ai/capabilities/function_calling/ |
| Mistral structured output overview | https://docs.mistral.ai/capabilities/structured_output/structured_output_overview/ |
| Mistral JSON mode | https://docs.mistral.ai/capabilities/structured_output/json_mode/ |
| Mistral models overview | https://docs.mistral.ai/getting-started/models/models_overview/ |
| Mistral prompting guide | https://docs.mistral.ai/guides/prompting_capabilities/ |
| LiteLLM Mistral provider | https://docs.litellm.ai/docs/providers/mistral |

When Mistral updates their docs (model lineup, deprecations, new features), re-fetch and update this file.
