# Slice 56 — Sklearn intent router with deterministic arg extraction

> **Prerequisite:** Slice 48 deployed (`bot_turn_metrics` + Langfuse session correlation — required to measure win rates and bootstrap training data). Slice 46 deployed (PostgresSaver — narrow LLM extraction calls need the same trace context). Tool-annotation hotfix `11c67ce` deployed (so `sideEffectLevel` and `whenToUse` reach the planner; the classifier is a layer ABOVE this, not a replacement).
> **Package:** `@cip/teams-bot`, `@cip/hr-service` (one migration), NEW container `@cip/intent-classifier` (Python FastAPI).
> **Verify:** A common HR query like "off-board jdoe@acme.com" routes via classifier → deterministic arg extraction → tool call, with `used_llm_planner=false` and total turn latency < 500ms. Less common phrasings ("the new contractor we hired last week") fall through to the existing full planner with `extraction_path='llm_fallback'` and the planner sees `intent_hint` in its system prompt. Per-tenant kill switch `lg.classifier_enabled = false` reverts a tenant to the pre-Slice-56 behaviour byte-for-byte.

---

## Why this slice exists

The current pipeline calls the planner LLM (`cip-router-careful`, mistral-small) on every turn that isn't pure chitchat. Per-turn cost: ~4500 prompt tokens + ~1.5–3s latency + the full tool-reference markdown re-rendered. For repetitive HR queries ("show my certs", "off-board X", "list staff in Y") the planner's "which tool" decision is wasted compute — the same answer comes out every time.

A CPU-fast intent classifier in front of the planner can:
- **Skip the planner entirely** when classification is high-confidence AND args can be extracted deterministically (~30-50% of HR traffic, by rough estimate).
- **Skip triage AND narrow the planner call** when classification is medium-confidence (planner gets just one tool's schema instead of all 30; ~15-20× prompt-token reduction even when an LLM still fires).
- **Capture the routing decision as labeled data** for retraining — every turn produces a `(text, intent, was_correct)` example.

This slice ships the classifier as a **separate Python service** (FastAPI + sklearn + joblib model artifact) rather than an in-process TypeScript matcher. Reasoning is in [PRE_LLM_ROUTING_STRATEGY.md](PRE_LLM_ROUTING_STRATEGY.md) — TL;DR: sklearn's discrimination on confusable HR intents (`view_certs` vs `submit_cert`, `disable_employee` vs `revoke_role`) is meaningfully better than KNN-over-embeddings for this use case, and the user has client docs to mine for ~200-500 examples per intent so cold-start isn't a blocker.

## What this slice IS

1. **`intent-classifier` service** — Python FastAPI container. Loads a joblib-pickled sklearn pipeline (TfidfVectorizer + LogisticRegression) at boot. Exposes `POST /classify` returning intent + confidence + per-class scores + suggested next_action.

2. **Per-tool deterministic extractor framework** in the bot. Each tool that the classifier can route to declares an extractor: a TypeScript function that takes the user message + auth context + DB pool and returns either `{ args }`, `{ missing: [...] }`, or `{ ambiguous: [...] }`.

3. **Templated clarification framework**. Each intent that can produce `next_action='clarify'` declares a Jinja2 template. When the classifier returns clarify, a deterministic question goes back to the user — no LLM.

4. **Templated disambiguation framework**. When the extractor returns `ambiguous: [...]` (DB lookup matched multiple records), an adaptive card with N buttons is sent. User taps; bot resumes with the picked id.

5. **New graph node `classify`** placed AFTER `ingest` and BEFORE `triage`. Routing decision in `routeAfterClassify`:
   ```
   confidence < lg.classifier_uncertain_threshold → triage (existing path)
   next_action = clarify                          → respond (templated, no LLM)
   next_action = call_tool + extraction_complete → execute (skip triage AND plan)
   next_action = call_tool + extraction_missing  → plan with narrowed tool list (one tool)
   next_action = call_tool + ambiguous           → respond (disambiguation card, no LLM)
   ```

6. **Langfuse + `bot_turn_metrics` schema additions** capturing classifier_intent, classifier_confidence, classifier_version, extraction_path, extracted_args_raw, resolved_args, missing_args, ambiguous_args, used_llm_extraction, used_llm_planner, outcome, correction_in_next_turn.

7. **Training-data export workflow** — a script reads from `bot_turn_metrics` + Langfuse traces, joins them, applies labeling rules (high-confidence successful turns → auto-labeled; problematic turns → review queue), produces `training_data.csv`. Runs nightly OR on-demand.

8. **Retraining script** — sklearn pipeline training + held-out eval + artifact upload to S3. Manual trigger initially; cron later.

9. **Tunables** for thresholds + kill switches.

## What this slice is NOT

- **Not a replacement for the planner.** The planner stays. The classifier is a fast pre-router; uncertain cases fall through unchanged.
- **Not a replacement for triage.** Triage stays for now (parallel runtime experimentation). Once the classifier proves itself we can deprecate triage in a follow-up.
- **Not a closed-loop auto-retraining pipeline.** v1 is manual: export → review → train → eval → deploy. Auto-retraining is a follow-up slice once we trust the data quality.
- **Not an LLM-classifier hybrid.** No LLM at runtime in the classify step. LLM is used OFFLINE for label assistance only.
- **Not an entity-extraction model in itself.** Extractors are per-tool, hand-written code (regex + DB lookup + narrow-LLM fallback). Each tool's extractor is the tool's own concern.
- **Not multi-tenant from day 1.** v1 is a single global model. Per-tenant model variants are a follow-up if traffic patterns diverge.

---

## The decision tree

```
ingest
  ↓
classify  (calls intent-classifier service via HTTP, ~10-30ms)
  ↓
routeAfterClassify:

  confidence < lg.classifier_uncertain_threshold (default 0.65)
     ↓ fallthrough
     triage → plan → ... (existing graph)
     [classifier_decision: 'fallthrough', extraction_path: null]

  next_action = 'clarify' AND confidence ≥ threshold
     ↓ deterministic clarification
     respond (Jinja template populated with intent + missing slot names)
     [classifier_decision: 'clarify', used_llm_planner: false, used_llm_extraction: false]

  next_action = 'call_tool' AND confidence ≥ threshold
     ↓ run per-tool extractor
       
       extractor returns { args: {...} }  (complete + unambiguous)
          ↓ skip planner entirely
          execute tool directly
          [classifier_decision: 'skip', extraction_path: 'deterministic',
           used_llm_extraction: false, used_llm_planner: false]
       
       extractor returns { ambiguous: [{id, label, hint}, ...] }
          ↓ no LLM
          respond (adaptive card with N buttons, on-tap fires execute with picked id)
          [classifier_decision: 'disambiguate', used_llm_planner: false]
       
       extractor returns { missing: [arg1, arg2, ...] }
          ↓ narrow planner call
          plan node — system prompt narrowed to JUST this tool's schema
          [classifier_decision: 'narrow_plan', extraction_path: 'llm_fallback',
           used_llm_extraction: true, used_llm_planner: false]
```

The four `classifier_decision` outcomes (`fallthrough`, `clarify`, `skip`, `disambiguate`, `narrow_plan`) are recorded per turn for win-rate analysis.

---

## Component 1 — `intent-classifier` Python service

**Why a separate service:** Python is the natural home for sklearn + joblib + the training pipeline. Embedding sklearn in the TypeScript bot would mean either a Node-side pickle reader (brittle) or shipping ONNX (lossy). Separate service keeps the model lifecycle clean.

### Container shape

```
packages/intent-classifier/
├── Dockerfile                  python:3.12-slim, pip install requirements.txt
├── requirements.txt            fastapi, uvicorn, scikit-learn, joblib, pydantic, opentelemetry-*
├── pyproject.toml              for local dev
├── src/
│   ├── main.py                 FastAPI app + /classify + /healthz
│   ├── classifier.py           load joblib model at startup; predict_proba wrapper
│   ├── schema.py               pydantic request/response models
│   └── otel.py                 Langfuse OTEL setup (if reachable)
├── models/
│   └── README.md               artifact lifecycle notes — actual artifacts in S3
├── training/
│   ├── export.py               read bot_turn_metrics + Langfuse → training_data.csv
│   ├── train.py                fit pipeline + cross-val + save .joblib
│   ├── label_assist.py         offline LLM helper for messy sessions
│   └── eval.py                 held-out scoring + per-intent F1
├── tests/
│   ├── test_classify.py        smoke + threshold tests
│   └── test_train.py
└── helm/
    ├── Chart.yaml
    ├── values.yaml
    └── templates/
        ├── deployment.yaml
        └── service.yaml
```

### `/classify` endpoint

```python
# request
{ "text": "off-board sarah mendez", "tenant_id": "uuid", "request_id": "turn-abc12345" }

# response
{
  "intent": "disable_employee",
  "next_action": "call_tool",          # call_tool | clarify | answer_directly | unknown
  "tool": "employee_disable",
  "confidence": 0.91,
  "scores": {                           # full per-class — top 5 only on the wire
    "disable_employee": 0.91,
    "revoke_role":      0.04,
    "view_certs":       0.02,
    "list_employees":   0.02,
    "small_talk":       0.01
  },
  "normalized": "off-board sarah mendez",
  "classifier_version": "v3-2026-05-15"
}
```

### Service responsibilities

- Load model artifact at boot. Failure → exit non-zero (k8s restart loop, alert fires).
- Health endpoint exposes loaded model version.
- Best-effort OTEL trace per request, attached to caller's request_id when present.
- Stateless: model is read-only after load. Multi-replica safe.
- Resource limits: 256MB RAM, 0.25 CPU. Sklearn models are tiny.

### Failure mode

If the service is unreachable or returns 5xx, the bot's `classify` graph node returns `null` and the graph falls through to triage. **No turn fails because of the classifier.** Logged as `[classify] service unreachable, falling through`.

---

## Component 2 — Per-tool extractor framework

```ts
// packages/teams-bot/src/intent/extractors/index.ts
export interface ExtractionResult {
  args?:      Record<string, unknown>;       // complete + unambiguous → execute
  ambiguous?: Array<{ id: string; label: string; hint?: string }>;  // disambiguation card
  missing?:   string[];                       // fall back to narrow planner
}

export interface ToolExtractor {
  toolName: string;
  extract: (
    text: string,
    ctx:  BotAuthContext,
    deps: { pool: pg.Pool },
  ) => Promise<ExtractionResult>;
}

export const EXTRACTORS: Record<string, ToolExtractor> = {
  employee_disable: { toolName: 'employee_disable', extract: extractEmployeeDisable },
  view_certs:       { toolName: 'view_certs',       extract: extractViewCerts },
  list_employees:   { toolName: 'list_employees',   extract: extractListEmployees },
  // ... ~10 high-volume tools to start; add more as classifier picks up new intents
};
```

Each extractor knows its tool's input schema. Examples:

```ts
// extractors/employee-disable.ts (sketch)
async function extractEmployeeDisable(text, ctx, { pool }): Promise<ExtractionResult> {
  // 1. Email pattern
  const email = text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i)?.[0];
  if (email) {
    const r = await pool.query('SELECT id FROM employees WHERE email = $1 AND tenant_id = $2 AND disabled_at IS NULL', [email, ctx.tenantId]);
    if (r.rows.length === 1) return { args: { employeeId: r.rows[0].id } };
  }
  // 2. Quoted name pattern
  const quoted = text.match(/"([^"]+)"|'([^']+)'/);
  if (quoted) {
    const name = quoted[1] || quoted[2];
    const r = await pool.query('SELECT id, full_name FROM employees WHERE tenant_id=$1 AND full_name ILIKE $2 AND disabled_at IS NULL', [ctx.tenantId, `%${name}%`]);
    if (r.rows.length === 1) return { args: { employeeId: r.rows[0].id } };
    if (r.rows.length > 1)   return { ambiguous: r.rows.map(row => ({ id: row.id, label: row.full_name })) };
  }
  // 3. "off-board <Name>" pattern (capitalized words after the verb)
  const verbName = text.match(/(?:off-?board|disable|deactivate|terminate|fire)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i);
  if (verbName) {
    const r = await pool.query('SELECT id, full_name FROM employees WHERE tenant_id=$1 AND full_name ILIKE $2 AND disabled_at IS NULL', [ctx.tenantId, `%${verbName[1]}%`]);
    if (r.rows.length === 1) return { args: { employeeId: r.rows[0].id } };
    if (r.rows.length > 1)   return { ambiguous: r.rows.map(row => ({ id: row.id, label: row.full_name })) };
  }
  return { missing: ['employeeId'] };
}
```

**Per-tool effort**: ~30-60 minutes of code per high-volume tool. Initial sweep covers the top ~10 tools (~5-10 hours of work). Extractors for less-common tools added on-demand.

---

## Component 3 — Templated clarification framework

```ts
// packages/teams-bot/src/intent/clarification-templates.ts
export const CLARIFICATION: Record<string, (slots: Record<string, unknown>) => string> = {
  disable_employee: (slots) =>
    `Who would you like to off-board? Reply with their name or email.`,
  view_certs: (slots) =>
    `Whose certifications? Type your own name for yours, or someone else's name for theirs.`,
  schedule_meeting: (slots) =>
    `When would you like to schedule it? Format like "tomorrow at 2pm" or "March 15 at 10:00".`,
  // ...one per intent that can produce next_action='clarify'
};
```

When `routeAfterClassify` chooses `clarify`, the respond node renders the template and ends the graph. **Zero LLM calls.**

---

## Component 4 — Templated disambiguation card

```ts
// packages/teams-bot/src/intent/disambiguation-card.ts
export function buildDisambiguationCard(args: {
  question:    string;                     // "Which employee did you mean?"
  candidates:  Array<{ id: string; label: string; hint?: string }>;
  resumeIntent: string;                    // 'disable_employee' — payload for the click
  resumeArgs:   Record<string, unknown>;   // already-extracted other args
}): AdaptiveCard {
  // Returns a card with a TextBlock + N Action.Submit buttons.
  // Each button's `data` field carries { resumeIntent, resumeArgs, employeeId: <picked> }.
  // Bot's invoke handler matches on resumeIntent and fires execute directly.
}
```

User taps a button → `messageBack` arrives at the bot → bot recognizes the resumeIntent payload → executes with the merged args. **Zero LLM calls.**

---

## Component 5 — Graph integration

State gets:

```ts
// state.ts — additions
classifierPrediction: Annotation<{
  intent:        string;
  next_action:   string;
  tool:          string | null;
  confidence:    number;
  scores:        Record<string, number>;
  classifier_version: string;
} | null>({ reducer: (_p, n) => n, default: () => null }),

extractionResult: Annotation<{
  path:        'deterministic' | 'llm_fallback' | null;
  args?:       Record<string, unknown>;
  missing?:    string[];
  ambiguous?:  Array<{ id: string; label: string; hint?: string }>;
} | null>({ reducer: (_p, n) => n, default: () => null }),
```

Graph wiring:

```ts
// graph.ts — additions
.addNode('classify',     makeClassifyNode(ctx))
.addNode('extractArgs',  makeExtractArgsNode(ctx))
.addEdge('ingest', 'classify')
.addConditionalEdges('classify', routeAfterClassify, {
  fallthrough:  'triage',           // existing path; classifier didn't help
  clarify:      'respond',          // templated clarification
  call_tool:    'extractArgs',
})
.addConditionalEdges('extractArgs', routeAfterExtraction, {
  execute:      'execute',          // deterministic complete
  disambiguate: 'respond',          // disambiguation card
  narrow_plan:  'plan',             // narrow LLM call
})
```

Plan node consumes `state.classifierPrediction` when present, narrowing its tool catalog and shortening the system prompt. Adds a `narrowedTo: [<toolName>]` field to its Langfuse generation metadata.

---

## Component 6 — Langfuse + `bot_turn_metrics` schema

### Migration NNN — `bot_turn_metrics` columns

```sql
ALTER TABLE bot_turn_metrics
  ADD COLUMN IF NOT EXISTS classifier_intent       TEXT,
  ADD COLUMN IF NOT EXISTS classifier_confidence   REAL,
  ADD COLUMN IF NOT EXISTS classifier_version      TEXT,
  ADD COLUMN IF NOT EXISTS classifier_decision     TEXT,    -- fallthrough|clarify|skip|disambiguate|narrow_plan
  ADD COLUMN IF NOT EXISTS extraction_path         TEXT,    -- deterministic|llm_fallback|null
  ADD COLUMN IF NOT EXISTS used_llm_extraction     BOOLEAN,
  ADD COLUMN IF NOT EXISTS used_llm_planner        BOOLEAN,
  ADD COLUMN IF NOT EXISTS correction_in_next_turn BOOLEAN; -- backfilled by analyzer
```

### Langfuse trace metadata additions (per turn)

```jsonc
{
  "intent":               "disable_employee",
  "tool":                 "employee_disable",
  "classifier_confidence": 0.91,
  "classifier_version":   "v3-2026-05-15",
  "next_action":          "call_tool",
  "extracted_args_raw":   { "name_match": "Sarah Mendez" },
  "resolved_args":        { "employeeId": "abc-123-uuid" },
  "missing_args":         [],
  "ambiguous_args":       [],
  "extraction_path":      "deterministic",
  "used_llm_extraction":  false,
  "used_llm_planner":     false,
  "outcome":              "tool_executed",
  "correction_in_next_turn": null
}
```

`correction_in_next_turn` is populated AFTER the next user turn arrives. A small post-turn analyzer (runs nightly) inspects each turn's next message for correction signals: thumbs-down, "no", "not that", "I meant", "wait", or rephrasing of the same intent. Marks the source turn `true`/`false`.

---

## Component 7 — Training-data export workflow

```python
# packages/intent-classifier/training/export.py (sketch)
# Reads from postgres + Langfuse, produces training_data.csv

# Auto-label criteria (HIGH confidence pulls):
#   - turn was 'tool_executed' outcome
#   - correction_in_next_turn = false
#   - classifier_decision in {'skip', 'narrow_plan'}
#   → label = (text=user_message, intent=classifier_intent, next_action=call_tool, tool=tool_called)

# Review queue (medium confidence):
#   - turn was 'tool_executed' outcome AND user thumbs-down
#   - turn used full planner fallthrough (no classifier signal) but resulted in tool call
#   - turn had correction_in_next_turn = true
#   → emit to review_candidates.csv

# Excluded (DO NOT train on):
#   - turn used the wrong tool and was corrected
#   - turn had high step_count (>= 4)
#   - user_corrected_bot
```

LLM-as-labeling-assistant runs OFFLINE on review_candidates.csv:
- Prompt: "given this session and these allowed intents/tools, label each user turn"
- Output: structured JSON per turn
- Marks `include_in_training=false` for uncertain examples
- Output goes to `llm_labeled.csv` for human review

Human review samples ~10% of LLM labels, corrects, then merges into `training_data.csv`.

---

## Component 8 — Retraining script

```python
# packages/intent-classifier/training/train.py
from sklearn.pipeline import Pipeline
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import cross_val_score
import joblib

pipe = Pipeline([
    ('tfidf', TfidfVectorizer(
        analyzer='word',
        ngram_range=(1, 2),
        min_df=2,
        max_df=0.95,
        lowercase=True,
        strip_accents='unicode',
    )),
    ('clf', LogisticRegression(
        max_iter=1000,
        class_weight='balanced',          # in case some intents have fewer examples
        C=1.0,
    )),
])

# train on training_data.csv (text → intent)
# cross_val_score → per-intent F1
# eval on held-out → confusion matrix
# eval gate: macro F1 must beat the previous artifact by ≥ 1pp
# save: classifier-v<NN>-<YYYY-MM-DD>.joblib → S3
```

v1 is **manual trigger** (run from a dev laptop with prod-trace access). Cron-driven retraining is a follow-up.

---

## Component 9 — Tunables

```sql
INSERT INTO bot_tunables (tenant_id, key, value_json, notes) VALUES
  ('00000000-0000-0000-0000-000000000000', 'lg.classifier_enabled',              'true',
   'Per-tenant kill switch. False reverts to pre-Slice-56 behaviour byte-for-byte.'),
  ('00000000-0000-0000-0000-000000000000', 'lg.classifier_uncertain_threshold',  '0.65',
   'Confidence below this falls through to triage+plan (no classifier hint passed).'),
  ('00000000-0000-0000-0000-000000000000', 'lg.classifier_high_threshold',       '0.85',
   'Confidence above this allows skip-LLM (deterministic extraction) AND deterministic clarification.'),
  ('00000000-0000-0000-0000-000000000000', 'lg.classifier_service_url',
   '"http://intent-classifier.cip-app.svc.cluster.local:8000"',
   'Internal URL for the classifier service.'),
  ('00000000-0000-0000-0000-000000000000', 'lg.classifier_timeout_ms',           '500',
   'Hard timeout. Exceeded → fall through to triage.')
ON CONFLICT (tenant_id, key) DO NOTHING;
```

---

## Files in scope

```
packages/intent-classifier/                                        NEW (whole directory)
├── Dockerfile / requirements.txt / pyproject.toml
├── src/main.py / classifier.py / schema.py / otel.py
├── training/export.py / train.py / label_assist.py / eval.py
├── tests/
└── helm/Chart.yaml / values.yaml / templates/{deployment,service}.yaml

packages/teams-bot/src/intent/extractors/                          NEW
├── index.ts                                                       NEW (registry)
├── employee-disable.ts                                            NEW
├── view-certs.ts                                                  NEW
├── list-employees.ts                                              NEW
└── ... ~10 high-volume tools to start

packages/teams-bot/src/intent/clarification-templates.ts           NEW
packages/teams-bot/src/intent/disambiguation-card.ts               NEW
packages/teams-bot/src/intent/classifier-client.ts                 NEW (HTTP client + 500ms timeout)

packages/teams-bot/src/langgraph/nodes/classify.ts                 NEW
packages/teams-bot/src/langgraph/nodes/extract-args.ts             NEW
packages/teams-bot/src/langgraph/state.ts                          (+ classifierPrediction, extractionResult fields)
packages/teams-bot/src/langgraph/graph.ts                          (insert classify + extractArgs nodes; new edges)
packages/teams-bot/src/langgraph/nodes/plan.ts                     (consume classifierPrediction; narrow tool list when present)
packages/teams-bot/src/langgraph/runner.ts                         (write new metrics columns)
packages/teams-bot/src/langgraph/util/turn-metrics.ts              (extend TurnMetric type)

packages/hr-service/src/db/migrations/NNN_classifier_metrics.sql   NEW (column additions)
packages/hr-service/src/db/migrations/NNN_classifier_tunables.sql  NEW (tunable seeding)
packages/hr-service/src/scripts/correction-analyzer.ts             NEW (nightly: backfill correction_in_next_turn)
packages/hr-service/helm/templates/correction-analyzer-cronjob.yaml NEW

scripts/create-secrets.sh                                          (+ classifier-credentials secret)
.github/workflows/build-and-push.yaml                              (+ intent-classifier matrix entry)
Makefile                                                            (no change — auto-discovered)

slices/SLICE_56_SKLEARN_INTENT_ROUTER.md                            this file
```

---

## Hard rules

- **No turn fails because of the classifier.** Service down / timeout / 5xx → `null` prediction → graph falls through to triage. Logged + alerting. Per-tenant kill switch via `lg.classifier_enabled`.
- **Tenant scoping is non-negotiable.** Every DB query in extractors filters by `ctx.tenantId`. Classifier is global (model artifact is the same for all tenants); tenant context applies during arg resolution.
- **No model-specific code.** Per `LLM_PROVIDER_NOTES.md`, the narrow LLM extraction path uses canonical chat-completion shape (system + user message). Same `cip-router-careful` alias as today's planner.
- **Server-side `assertPermission` is the security gate.** The classifier may pick a tool the user can't actually invoke. The hr-service handler refuses; the bot logs the refusal in `tools_refused` and the next user message can correct.
- **Deterministic clarifications + disambiguations log explicitly.** `outcome: 'clarification_sent'` / `'disambiguation_sent'`, `used_llm_planner: false`, `used_llm_extraction: false`. Lets us measure what fraction of turns the classifier short-circuits.
- **Training data quality > training data quantity.** Auto-label only `tool_executed AND correction_in_next_turn=false`. Everything else goes to review queue. NEVER train on a turn where the bot used the wrong tool unless a human relabeled it.
- **Eval gate before promotion.** A new model artifact must beat the prior macro-F1 by ≥ 1pp on held-out data, AND must not regress per-intent F1 by > 5pp on any single intent. Manual eval initially; CI gate later.
- **Confidence thresholds are tunables, not constants.** Operators can tighten `lg.classifier_high_threshold` per-tenant if a tenant's intent distribution skews the calibration.

---

## Phased rollout

**Phase 1 — Shadow mode (week 1-2)**
- Ship the classifier service + classify graph node.
- `routeAfterClassify` ALWAYS returns `fallthrough` regardless of confidence — no behavior change.
- Record everything in `bot_turn_metrics`.
- Outcome: 1-2 weeks of paired data ("what would the classifier have done" alongside "what the planner actually did").
- Gate: classifier agreement with final planner outcome must exceed 85% on common intents before flipping any router behavior.

**Phase 2 — Clarification + disambiguation only (week 3)**
- Flip `routeAfterClassify` to honor `clarify` and `disambiguate` decisions for one canary tenant.
- Skip / narrow_plan still fall through to today's path.
- Lowest risk: clarification + disambiguation never EXECUTE a tool, so a wrong classification just sends a wrong question.

**Phase 3 — Narrow_plan (week 4)**
- Flip `narrow_plan` for the canary tenant.
- Planner runs but with one tool's schema instead of 30. Token cost drops; the bot still validates via the planner before tool execution.

**Phase 4 — Skip (week 5+)**
- Flip `skip` (deterministic execution, no LLM) for the canary tenant on tools with high-confidence extractors.
- Watch `tools_refused`, `correction_in_next_turn`, and user thumbs-down rates.
- Roll out to other tenants tier-by-tier as confidence accumulates.

**Phase 5 — Drop triage (later, separate slice)**
- Once classifier covers all the routing decisions triage was making, deprecate the triage node entirely. Removes one LLM call per turn from EVERY turn (not just classifier-skipped ones).

---

## Verification

**Shadow mode (Phase 1):**
- After 100 turns: query `bot_turn_metrics` — every row has `classifier_intent` and `classifier_confidence` populated. `classifier_decision = 'fallthrough'` on every row (we haven't flipped routing yet).
- Run agreement query: how often did classifier_intent match what the final planner picked? Want ≥ 85% on the top-10 intents.
- Look at low-confidence-but-correct turns. Adjust `lg.classifier_uncertain_threshold` if the default 0.65 cuts off useful predictions.

**Phase 2 (clarify + disambiguate):**
- Send "off-board someone" → classifier predicts `disable_employee`/`clarify` → bot returns templated "Who would you like to off-board?". `bot_turn_metrics` row shows `classifier_decision='clarify', used_llm_planner=false, total_ms < 200`.
- Send "off-board Sarah" with three Sarahs in DB → extractor returns `ambiguous: [...]` → bot sends adaptive card with 3 buttons. Tap a button → execute fires.

**Phase 3 (narrow_plan):**
- Send "off-board the new contractor" → classifier predicts `disable_employee` confident → extractor returns `missing: ['employeeId']` → narrow planner call fires with just `employee_disable`'s schema. Verify generation in Langfuse: `prompt_tokens` is dramatically lower than the full planner.

**Phase 4 (skip):**
- Send "off-board jdoe@acme.com" → classifier confident → email regex matches → DB lookup returns 1 → tool fires. `bot_turn_metrics`: `used_llm_planner=false, used_llm_extraction=false, total_ms < 300`.
- Pod log shows ZERO LLM calls for that turn.

**Failure modes:**
- Stop the classifier service → bot continues serving turns via fallthrough → `bot_turn_metrics` rows show `classifier_intent=null, classifier_decision='fallthrough'`. Alert fires.
- Set `lg.classifier_enabled=false` for one tenant → that tenant's turns skip the classifier entirely (graph short-circuits classify node to immediate fallthrough). Other tenants unaffected.

**Retraining loop:**
- Run `python training/export.py --since='30d'` → `training_data.csv` produced.
- Run `python training/train.py` → cross-val score reported, artifact saved.
- Compare against current production artifact. Promote only if eval gate passes.
- Run `python training/label_assist.py review_candidates.csv` → `llm_labeled.csv`. Sample 10% for human review.

---

## Risks + mitigations

| Risk | Mitigation |
|---|---|
| Classifier picks wrong intent confidently → wrong tool fires (skip path) | Server-side `assertPermission` refuses invalid calls; `correction_in_next_turn` analyzer flags → review queue → exemplar added to retraining data |
| Extractor returns wrong DB record (name collision) → wrong action | Disambiguation path catches multi-match cases. Single-match cases protected by gate-write confirm for write tools (Slice 46b). Worst case the user sees the confirm prompt and cancels. |
| Classifier service becomes a single point of failure | 500ms hard timeout in classifier-client. Health check + multi-replica deployment. Per-tenant kill switch as the manual override. |
| Training data drift (new tools / new intents added without retraining) | Eval gate detects per-intent F1 regression. Drift monitoring (run `eval.py` weekly on a frozen test set) catches calibration shifts. |
| Cold start: first 200 examples per intent are hand-curated → bias toward author's phrasing | Phase 1 shadow mode collects real-world phrasings for 1-2 weeks before any routing decision flips. |
| LLM-labeling assistant introduces noise | Human-review 10% sample; reject the assistant's labels for any intent where its accuracy on the reviewed sample falls below 90%. |
| Per-tool extractor maintenance burden as tools change | Extractors live next to tools; tool changes prompt extractor changes in the same PR. CI lint can warn when a tool's input schema changes without an extractor update. |
| Adaptive card disambiguation doesn't render on all Teams clients | Card uses Adaptive Cards 1.4 (broad client support); fallback to a text "1) Sarah Mendez 2) Sarah Liu — reply with the number" if card rendering fails. |
| Mistral model + LiteLLM still being the long pole on `narrow_plan` turns | Even narrow_plan is 5-15× cheaper than today's full planner. If still too slow, swap to a lighter model alias just for narrow extraction (`cip-classifier` nemo). |

---

## Out of scope (still deferred)

- Per-tenant model variants (one global model in v1).
- Auto-retraining cron (manual trigger only in v1).
- Closed-loop active learning (review queue → auto-add high-confidence corrections to training data without human review).
- Replacing triage entirely (separate later slice once Phase 4 is stable).
- Fine-tuning the LLM-as-labeling-assistant on our domain (off-the-shelf prompted Mistral suffices for v1).
- Multi-label intents ("list staff AND disable Bob" is two intents in one turn).

---

## Cross-slice notes

- Builds on Slice 48's `bot_turn_metrics` + Langfuse trace correlation. Adds columns; does not break existing schema.
- The narrow-planner path passes `classifierPrediction` into `plan.ts`; complements the existing tool_reference markdown (Slice 45) by overriding it with the single-tool schema when the classifier is confident.
- Slice 46b's native `interrupt()` is unaffected — write-confirm gating still runs on all execute paths regardless of how the tool was selected (deterministic vs narrow_plan vs full planner). The classifier doesn't bypass the confirm gate.
- Slice 53's adaptive-card confirm UI applies equally to classifier-routed write actions — they go through the same gateWrite + confirm flow.
- The extractor framework is a clean place to add per-tool entity normalization — could grow into a "tool helpers" module that other parts of the codebase use too.
- Phase 5 (drop triage) is a separate slice. After Slice 56 is stable, triage's narrow role (clarification flagging) is something the classifier already does better.
