# Slice 56 family — alignment review (canonical)

> **Status:** This document is the **canonical architecture** for the slice 56 family
> as of 2026-05-04. It supersedes the conflicting bits of decisions documented in
> SLICE_56_SKLEARN_INTENT_ROUTER.md, SLICE_55_ARG_EXTRACTION_FRAMEWORK.md,
> SLICE_56B/C/D/E.md when they disagree. The earlier docs remain as historical
> record.
>
> **Why this doc exists:** the slice 56 family was written incrementally and shipped
> with three competing answers to "what is good training data?" We hit the inconsistency
> in production (intermittent failures, fragmented training UX, classifier never says
> "I don't know"). The review below resolves those into one coherent picture, anchored
> in evidence-based practice (citations in section 5).

---

## 1. The three competing philosophies — and how we resolve them

| Source | "Good training row" filter | What ships? |
|---|---|---|
| Slice 56 (original) | `tool_executed AND correction_in_next_turn=false AND classifier_decision IN {skip, narrow_plan}` | `correction_in_next_turn` analyzer **never built**. Filter never enforced. |
| Slice 55 | Manual: `/teach` or `/turn` "Add to training set" button. Every row needs human approval. | `/teach` shipped. **`/turn` button never built.** |
| Slice 56E (shipped) | `single tool ran AND no refusal AND no clarification AND no confirmation AND tool in TOOL_TO_INTENT` (layer-agnostic). Marks `reviewed=false` so admin still approves. | This is what's actually in production. |

**Reconciliation.** All three filters become **tiers in a single trust ladder**, computed at import time from existing columns. We don't choose between them — we rank them.

```
trust tier (computed at import time, NOT a column):

  tier 4: explicit user 👍 verdict on the bot's reply        (highest trust)
  tier 3: explicit user correction text ("should have called X")
  tier 2: clean-success heuristic AND grammar/classifier routed the tool
  tier 1: clean-success heuristic AND LLM-planner routed the tool   (lowest trust)
```

All four tiers land in `bot_intent_training_data` with `reviewed=false`. **All four
require admin review** before feeding the trainer. We may later auto-approve tier 3
(corrections) once we have evidence the verdict signal is high quality — but not in v1.

The trust tier is **derived from the existing `source` enum + classifier-decision metadata
on the source turn**. No new column required.

---

## 2. Promised vs shipped — the 8 known gaps

| Promised | Shipped? | Resolution |
|---|---|---|
| Per-tool extractor framework | ✓ | n/a |
| Grammar router | ✓ | n/a |
| Disambiguation card | ✓ | n/a |
| `/teach` slash command | ✓ | n/a |
| **`/turn` "Add to training set" button** | ✗ | **Slice 56K** — extend the existing `/turn` card |
| **`correction_in_next_turn` analyzer** | ✗ | **Replaced by explicit verdict UI in 56F** — explicit > implicit per research |
| **Plan node consumes `classifierPrediction` to narrow tool catalog** | ✗ | **Slice 56I** — wire it for real; today's `narrow_plan` decision is theatrical |
| **Eval gate (≥1pp macro-F1, no per-class regression > 5pp)** | ✗ | **Slice 56J** — restore in cron entrypoint |
| Auto-retraining cron | ✓ | 56C |
| Per-tenant models | ✓ | 56D |
| Trace export | partial | **Slice 56H** — make it trust-tier-aware |
| Confidence thresholds tunable | ✓ | n/a |
| `out_of_scope` / OOD class | ✗ (never proposed) | **Slice 56G** — emerged from research as the structural fix |

---

## 3. Unified architecture — one picture

### Data model additions (one migration, one source-enum extension)

```sql
-- migration 032
ALTER TABLE bot_turn_metrics
  ADD COLUMN IF NOT EXISTS user_verdict     TEXT,        -- 'positive' | 'negative' | NULL
  ADD COLUMN IF NOT EXISTS user_correction  TEXT,        -- free-text "should have…" | NULL
  ADD COLUMN IF NOT EXISTS user_verdict_at  TIMESTAMPTZ;

CHECK (user_verdict IS NULL OR user_verdict IN ('positive', 'negative'));

-- bot_intent_training_data source enum extended
ALTER TABLE bot_intent_training_data
  DROP CONSTRAINT bot_intent_training_data_source_check;
ALTER TABLE bot_intent_training_data
  ADD CONSTRAINT bot_intent_training_data_source_check
    CHECK (source IN ('teach', 'turn_label', 'manual_csv', 'trace_export',
                      'verdict_positive', 'confusion_correction'));
```

### Verdict lifecycle (slice 56F)

```
production turn → bot replies
  ↓
respond.ts emits the response card
debug-banner.ts footer extended:
  ┌─────────────────────────────────────────────────┐
  │ ⏱ 0.78s · grammar=verb_list_staff · turn=ed2ce649 │
  │ [👍 Helpful] [👎 Wrong] [🔍 Inspect]              │
  └─────────────────────────────────────────────────┘
  ↓ tap 👍
  /turn-feedback ed2ce649 positive
  ↓
  hr-service: bot_turn_feedback_record MCP tool
  → UPDATE bot_turn_metrics SET user_verdict='positive', user_verdict_at=NOW()
  → No follow-up; bot acknowledges silently or with a one-line confirmation

  ↓ tap 👎
  /turn-feedback ed2ce649 negative
  ↓
  bot replies with FOLLOW-UP CARD:
  ┌─────────────────────────────────────────────────┐
  │ What should it have done?                       │
  │ [text input]                                    │
  │ ☐ Wrong tool                                    │
  │ ☐ Wrong arguments                               │
  │ ☐ Should have asked me                          │
  │ ☐ Other                                         │
  │ [Submit]                                        │
  └─────────────────────────────────────────────────┘
  ↓ submit
  /turn-feedback-detail ed2ce649 <correction-text>
  ↓
  hr-service: bot_turn_feedback_record_detail MCP tool
  → UPDATE bot_turn_metrics SET user_verdict='negative', user_correction='…'
```

### Import lifecycle (slice 56H — replaces today's blanket import)

```
import_traces.py runs (weekly, in-cluster):

  1. Pull rows from bot_turn_metrics (last N days, langfuse_trace_id NOT NULL).
  2. For each row, compute trust_tier:

     tier 4: user_verdict='positive'                     → source='verdict_positive'
     tier 3: user_verdict='negative' AND user_correction → source='confusion_correction'
     tier 2: clean-success heuristic AND
             (grammar_pattern IS NOT NULL OR
              classifier_decision IN ('skip','narrow_plan'))
                                                          → source='trace_export'
     tier 1: clean-success heuristic AND LLM-routed       → source='trace_export'
                                                            (low priority, optional skip)

  3. SKIP rows with user_verdict='negative' and NO correction text
     (we know it was wrong; we don't know what was right; useless for training).

  4. For each candidate, fetch user text from Langfuse.
  5. Dedup against existing rows by (tenant_id, intent, lower(text)).
  6. INSERT with reviewed=false. notes column records trust_tier for audit.
```

### Out-of-scope detection (slice 56G — the main user-visible win)

```
Three changes:

  1. manual_examples.csv: add 30+ out_of_scope rows
     (mix: ~15 hand-written domain-relevant negatives like "what's the weather",
           ~15 sampled from CLINC150's open-source OOS corpus)

  2. Bolster other under-represented classes to ≥15/class
     (current: 4-11/class; Rasa-recommended floor: 10-15)

  3. Restore lg.classifier_uncertain_threshold from 0.20 → 0.55
     (we lowered it to 0.20 only because the 51-row corpus had max confidences
      of ~0.30. With ≥15/class + an OOS class, max confidences will rise and
      the threshold gating becomes meaningful again.)
```

### Narrow plan, for real (slice 56I)

```
plan.ts today: takes the full discoverTools result regardless of classifier signal.
plan.ts after: when state.classifierPrediction.tool is set AND classifier_decision='narrow_plan',
              filter discoverTools result to just that one tool's schema.

This is what the original Slice 56 promised: 5-15× prompt-token reduction on
narrow_plan turns. Today the metric column says 'narrow_plan' but the actual
LLM call sees the full catalog — the decision is theatrical.
```

### Eval gate (slice 56J)

```
cron_entrypoint.sh today: runs `python -m training.train` with no eval gate.
cron_entrypoint.sh after: runs `python -m training.eval --baseline=<latest>` first;
                          aborts the train if the candidate fails the gate.

Gate (already in eval.py, just disabled by default):
  - macro-F1 must beat baseline by ≥ args.min_improvement (default 0.01)
  - no single intent F1 may regress by > args.max_regression (default 0.05)
  - if either fails, exit 2 → cron job fails → no upload → no model rotation
```

### `/turn` "Add to training set" button (slice 56K)

```
Slice 55 promised this; never built. Now ships as part of the verdict-UX
infrastructure (same messageBack pattern, same MCP tool surface).

User runs `/turn ed2ce649` to inspect a past turn → card adds:
  [📚 Add to training set]
  ↓ tap
  /turn-label ed2ce649
  ↓
  bot replies with a follow-up card asking to confirm intent + tool
  ↓
  bot_intent_training_data_add MCP tool (existing, slice 56B) writes
  source='turn_label', source_turn_id=<turnId>, reviewed=false
```

---

## 4. UX rule — keep it simple in v1

Every reply gets the verdict footer (`👍 / 👎 / 🔍 Inspect`). No per-routing-layer
gating in v1.

The "only show on uncertain turns" optimization (LUIS-style margin sampling) is a
56F follow-up that requires evidence:

- Measure: what fraction of grammar-routed turns get 👎?
- If < 1%, add a tunable to suppress the verdict UI on grammar-routed turns.
- If ≥ 1%, keep the UI universally — grammar is wrong often enough that the verdict
  data is worth the UX cost.

We don't pre-optimize before measuring.

---

## 5. Evidence anchors

Every non-trivial design choice in this doc traces to an external source.

- **Trust ladder ranking** — Arize routing best practices [20] and the broader
  intent-classifier literature: classifier-confirmed turns are higher-quality
  training data than LLM-routed clean-success turns.
- **Explicit verdict > implicit clean-success** — PAIR feedback guidance [24],
  Microsoft LUIS active-learning loop [7], Rasa CDD [5].
- **Negative verdict + correction text = highest signal** — PAIR's "always train on
  explicit corrections when you can get them" [24]; Rasa Interactive Learning [5].
- **Reviewed=false default; admin curates** — Rasa, LUIS, Botpress all do this [5][7][10].
  Auto-approval requires evidence; we don't have it yet.
- **`out_of_scope` class** — Larson et al. EMNLP-IJCNLP 2019 (CLINC150 benchmark) [18];
  explicit OOS class outperforms threshold-only rejection.
- **≥15 examples per class** — Rasa published floor 10, community guidance 15-20 [14].
- **Sub-corpus mining (CLINC150)** — Apache 2.0 licensed; 1000 OOS test examples
  available; widely used as the OOD-evaluation benchmark for intent classifiers.
- **Eval gate ≥1pp macro-F1, ≤5pp per-class regression** — Slice 56's own original
  decision; standard MLOps non-regression pattern [29].
- **Active learning (margin sampling)** — Mussmann & Liang ICML 2018 [11], Lewis &
  Gale 1994 (classic). 3× label efficiency vs random.
- **Adaptive-card patterns** — Slice 55's disambiguation card, Slice 46e's `/turn`
  Inspect button. Same `messageBack → slash command → MCP tool` plumbing in all
  three places.

(Source numbers map to the citations in the prior research report.)

---

## 6. Slice plan + ordering

Each slice is a separate commit. Each one is self-contained and ships an end-to-end
capability. Order matters: 56F first because everything else depends on the schema
and verdict mechanism.

| # | Title | What ships | Migration? |
|---|---|---|---|
| 56F | Verdict UX | bot_turn_metrics columns, footer 👍/👎/Inspect, follow-up card on 👎, slash dispatch, MCP tools, source enum extended | 032 |
| 56G | OOD class | manual_examples.csv +30 out_of_scope rows + bolster to ≥15/class, threshold restore, retrain | none |
| 56H | Trust-tier import | import_traces.py reads user_verdict, computes trust tier from source, prefers explicit verdicts | none |
| 56I | Narrow plan | plan.ts filters discoverTools result by classifierPrediction.tool when classifier_decision='narrow_plan' | none |
| 56J | Eval gate | cron_entrypoint.sh wraps train with eval --baseline; aborts on regression | none |
| 56K | /turn add-to-training button | extend /turn card with 📚 button; new slash dispatcher; new MCP tool | none |

Total: ~6 commits, 1 migration, no schema breaks, no breaking API changes.

---

## 7. What's deliberately deferred

Things the research mentioned that we're NOT building in this round:

- **Active-learning margin sampling for review priority** (LUIS-style "show
  uncertain turns first"). Adds value once we have ≥1000 unreviewed rows; today
  we have ~50.
- **Per-class F1 dashboard.** Useful for debugging confusion pairs; can wait until
  the corpus is mature.
- **CLINC150 as a frozen test set in CI.** Defer to 56J's natural extension.
- **Migrating off sklearn LR to a tiny fine-tuned encoder (SetFit, distilBERT).**
  Defer until 56G + corpus growth shows a plateau in macro-F1.
- **Auto-approval of explicit-correction rows.** Wait for evidence on verdict
  signal noise rate. Operator review remains the gate.
- **Confusion-matrix-driven correction-text prompts** (suggesting candidate intents
  in the 👎 follow-up card). Nice UX, not blocking.

---

## 8. Hard rules carried forward

These were established in 56/56B/56C/56D/56E and remain inviolate:

- **No turn fails because of routing layers.** Classifier down, grammar errored,
  verdict tool unreachable — every error path falls through to the existing planner.
- **Per-tenant kill switches everywhere.** `lg.classifier_enabled`,
  `lg.grammar_router_enabled`, `lg.verdict_ui_enabled` (NEW in 56F).
- **Tenant scoping non-negotiable.** Every DB query carries `ctx.tenantId`.
- **Server-side `assertPermission` is the security gate.** Verdict feedback doesn't
  bypass any existing permission checks.
- **No model-specific code.** Same `cip-router-careful` alias as today's planner.
- **Eval before promotion.** 56J restores this.
- **Reviewed=false on auto-import.** Admin curates; system never auto-trains on
  unreviewed data.
