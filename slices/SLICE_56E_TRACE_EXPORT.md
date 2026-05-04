# Slice 56E — Langfuse trace-export auto-labelling

Mine production turns for high-confidence training data. Every
clean-success turn (single tool ran, no refusals, no clarification,
no confirmation) becomes a candidate row in `bot_intent_training_data`
with `source='trace_export'` and `reviewed=false`. Operator approves
via `make training-data-review` → `mark-reviewed`, just like /teach
entries.

This is the persistence story the user asked about in 56B:
"shouldn't they be stored in a table for later reference and updates
to keep them persisted?" Langfuse retention is finite; the labelled
row in our DB is permanent and survives any Langfuse purge.

## Decisions

| Q | A | Why |
|---|---|---|
| Heuristic | Single tool attempted + 0 refused + clarification_fired=false + confirmation_fired=false. The user got their answer in one shot — that's the strongest implicit "this routing was correct" signal we can read non-interactively. | Anything that needed clarification, hit a refusal, or stacked multiple tools is ambiguous data. We'd rather skip an arguable label than poison the training set. |
| Where the user text comes from | Langfuse trace's `input.latestUserText`. `bot_turn_metrics` deliberately doesn't store user text (privacy by default); Langfuse already does. | One source of truth for raw text. The DB stores only labels + lineage. |
| Intent label derivation | Hand-mapped from tool name (table in `import_traces.py`). Skip turns whose tool isn't in the map. | The classifier's own prediction is in `bot_turn_metrics.classifier_intent`, but training on the classifier's output is a feedback loop. Hand-mapping is conservative; the map updates as we add tools. |
| Default lookback | 7 days | Long enough to catch a typical week's signal, short enough that we re-run weekly without thinking. |
| Dedup key | `(tenant_id, lower(text), intent)` | Same prompt repeated across days shouldn't blow up the corpus. |
| reviewed=false on insert | Yes — admin still approves | Auto-labelling is high-volume and needs the same human gate as /teach. The next train round won't pick these up until they're approved. |

## Files

| File | Change |
|---|---|
| `packages/hr-service/src/db/migrations/031_trace_export_source.sql` (new) | Drop + recreate the source CHECK to include `'trace_export'`. Add `source_langfuse_trace_id TEXT` column for the dedicated trace-id reference (separate from `source_turn_id` which holds the bot's 8-char turnId). |
| `packages/intent-classifier/requirements.txt` | Add `langfuse>=2,<4` (Python SDK — used in CLI mode only, not by the service runtime). |
| `packages/intent-classifier/training/import_traces.py` (new) | The importer. Queries `bot_turn_metrics` for clean candidate turns, fetches each trace from Langfuse for the user text, dedupes against the corpus, INSERTs reviewed=false rows. |
| `Makefile` | `training-data-import-traces` target: `python -m training.import_traces --days <N>`. |
| `packages/hr-service/src/db/queries/bot-intent-training-data.ts` | `AddTrainingDataInput.sourceLangfuseTraceId?` + `TrainingDataRow.source_langfuse_trace_id`. |

## Tool → intent map (v1)

```python
TOOL_TO_INTENT = {
  "employee_disable":         "disable_employee",
  "employee_find":            "find_employee",
  "employee_list":            "list_employees",
  "get_employee_permissions": "get_employee_permissions",
  "get_my_certifications":    "get_my_certifications",
  "get_staff_certifications": "get_staff_certifications",
}
```

Tools not in the map → skip the turn. Add to the map alongside any new
extractor / grammar pattern.

## Out of scope

- Pulling the full session context to handle multi-turn intent (the
  user asked one thing then switched topic — we'd lose the second).
- Auto-marking reviewed=true based on classifier-agreed-with-tool —
  that's the feedback loop we're avoiding in v1.
- A Helm CronJob for trace import (operator-triggered for now).
